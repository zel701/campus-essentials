import json
import boto3
import uuid
from datetime import datetime

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('campus-essentials')

def handler(event, context):
    try:
        # Ensure this is a POST
        if event["httpMethod"] != "POST":
            return {
                "statusCode": 405,
                "body": json.dumps({"message": "Only POST method allowed."})
            }

        # Parse JSON body
        body = json.loads(event.get("body", "{}"))
        url = body.get("url")
        price = body.get("price")

        if not url or not price:
            return {
                "statusCode": 400,
                "body": json.dumps({"message": "Missing 'url' or 'price' in request body."})
            }

        # Generate an item ID with prefix to prevent collision
        item_id = f"price:{url}"

        # Put item into DynamoDB
        table.put_item(Item={
            "id": item_id,
            "url": url,
            "price": price,
            "timestamp": datetime.utcnow().isoformat()
        })

        return {
            "statusCode": 200,
            "body": json.dumps({"message": "Data stored successfully."})
        }

    except Exception as e:
        return {
            "statusCode": 500,
            "body": json.dumps({"message": f"Internal server error: {str(e)}"})
        }



