const AWS = require('aws-sdk')
const BigCommerce = require('node-bigcommerce')
const dyanamoDbClient = new AWS.DynamoDB.DocumentClient()
const sqsClient = new AWS.SQS()
const bigCommerce = new BigCommerce({
    logLevel: 'info',
    clientId: process.env.CLIENT_ID,
    accessToken: process.env.TOKEN,
    storeHash: process.env.STORE_HASH,
    responseType: 'json',
    apiVersion: 'v2'
})
const queueURL = process.env.SQS_QUEUE_URL
const table = process.env.TABLE
const newPhysicalOrderStatusId = 9 // 9 is 'Awaiting Shipment'
const newDigitalOrderStatusId = 8 // 8 is 'Awaiting Pickup' by default. Rename to 'Digital Order Complete'

const getBigCommerceRetry = async (resource, n) => {
    // Default max attempts is 3
    n = n ? n : 3
    try {
        return await bigCommerce.get(resource)
    } catch (err) {
        if (n === 1) throw err
        console.warn('ERROR', err, err.stack)
        return await getBigCommerceRetry(resource, n - 1)
    }
}

const putBigCommerceRetry = async (resource, payload, n) => {
    // Default max attempts is 3
    n = n ? n : 3
    try {
        return await bigCommerce.put(resource, payload)
    } catch (err) {
        if (n === 1) throw err
        return await getBigCommerceRetry(resource, n - 1)
    }
}

const getOrderSubresources = async order => {
    try {
        const products = await getBigCommerceRetry(order.products.resource)
        const shipping_addresses = await getBigCommerceRetry(order.shipping_addresses.resource)
        const coupons = await getBigCommerceRetry(order.coupons.resource)

        order.products = products
        order.shipping_addresses = shipping_addresses
        order.coupons = coupons

        return order
    } catch (err) {
        console.warn(err, err.stack)
        throw err
    }
}

exports.handler = async (event, context) => {
    // Default Response
    const response = {
        statusCode: 500,
        body: JSON.stringify('Something is wrong.'),
    }
    try {
        // Retrieve products, shipping addresses, and coupons for each order
        // before storing it and removing the message from the queue.
        const { Records } = event

        // Request subresources for 1 order at a time.
        // Control concurrency by setting the Lambda
        // function's reserved concurrency (Default 3)
        for (let i = 0; i < Records.length; i++) {
            const message = Records[i]
            const order = JSON.parse(message.body)
            console.log(`Getting subresources for order ${order.id}`)
            const orderWithSubresources = await getOrderSubresources(order)

            // Put the order into DynamoDB
            const putParams = {
                TableName: table,
                Item: order
            }
            console.log(`Writing order ${order.id} to DynamoDB`)
            await dyanamoDbClient.put(putParams).promise()

            // Update order state in BC
            console.log(`Success, updating order status in BC`)
            const status_id = order.order_is_digital
                ? newDigitalOrderStatusId
                : newPhysicalOrderStatusId
            const payload = { status_id }
            await putBigCommerceRetry(`/orders/${order.id}`, payload)

            // Publish to SNS 
            console.log(`Success, sending Processed Notification`)
            const sns = new AWS.SNS()
            const messageParams = {
                TopicArn: process.env.PROCESSED_SNS_TOPIC_ARN,
                Subject: `New Order ${order.id}`,
                Message: `
====================
NEW ORDER ${order.id} has been placed.
Status: ${order.status}
Payment Method: ${order.payment_method}
Payment Total: ${order.total_inc_tax}
${order.customer_message}
====================
${order.shipping_addresses?.[0]?.shipping_method}
SHIP TO
${order.shipping_addresses?.[0]?.first_name} ${order.shipping_addresses?.[0]?.last_name}
${order.shipping_addresses?.[0]?.company}
${order.shipping_addresses?.[0]?.street_1}
${order.shipping_addresses?.[0]?.street_2}
${order.shipping_addresses?.[0]?.city}, ${order.shipping_addresses?.[0]?.state} ${order.shipping_addresses?.[0]?.zip}
${order.shipping_addresses?.[0]?.country}
====================
${order.products?.map(product => "Sku: " + product.sku + " Quantity: " + product.quantity + " Name: " + product.name)?.join("\n")}
====================
`
            }
            await sns.publish(messageParams).promise()

            // Remove the message from the queue
            console.log(`Success, deleting message ${message.messageId}`)
            const deleteParams = {
                QueueUrl: queueURL,
                ReceiptHandle: message.receiptHandle
            }
            await sqsClient.deleteMessage(deleteParams).promise
            console.log(`Success fully deleted message ${message.messageId}`)
        }

        response.statusCode = 200
        console.log(`Successfully wrote ${Records.length} orders to DynamoDB`)
        response.body = JSON.stringify({
            status: 200,
            message: `Successfully wrote ${Records.length} orders to DynamoDB`
        })
        return response
    }
    catch (err) {
        console.error(err, err.stack)
        throw err
    }
}