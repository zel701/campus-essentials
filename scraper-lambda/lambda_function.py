"""Authenticated storage for supplied prices. No website scraping is performed."""
import base64
import hmac
import json
import os
from datetime import datetime, timezone
from decimal import Decimal
from urllib.parse import urlparse

import boto3

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,x-admin-password",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
}


def response(status, message):
    return {"statusCode": status, "headers": CORS_HEADERS, "body": json.dumps({"message": message})}


def is_admin(event):
    expected = os.environ.get("ADMIN_PASSWORD", "")
    if not expected:
        return False
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    auth = headers.get("authorization", "")
    bearer = auth[7:].strip() if isinstance(auth, str) and auth.lower().startswith("bearer ") else None
    return any(isinstance(value, str) and hmac.compare_digest(value.encode(), expected.encode())
               for value in [headers.get("x-admin-password"), bearer])


def handler(event, context):
    method = event.get("httpMethod")
    if method == "OPTIONS":
        return response(200, "CORS preflight success")
    if method != "POST":
        return response(405, "Only POST method allowed.")
    if not is_admin(event):
        return response(403, "Invalid admin password.")
    try:
        raw = event.get("body") or "{}"
        if event.get("isBase64Encoded"):
            raw = base64.b64decode(raw, validate=True).decode("utf-8")
        body = json.loads(raw, parse_float=Decimal, parse_int=Decimal)
        if not isinstance(body, dict):
            return response(400, "Body must be a JSON object.")
        url, price = body.get("url"), body.get("price")
        if not isinstance(url, str) or len(url.encode()) > 2042 or urlparse(url).scheme not in ("http", "https") or not urlparse(url).netloc:
            return response(400, "url must be a valid HTTP or HTTPS URL of at most 2042 bytes.")
        if not isinstance(price, Decimal) or not price.is_finite() or price < 0:
            return response(400, "price must be a non-negative number.")
    except (ValueError, TypeError, UnicodeError):
        return response(400, "Body must contain valid JSON.")

    try:
        table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
        table.put_item(Item={
            "id": f"price:{url}", "entity": "item", "url": url,
            "price": price, "timestamp": datetime.now(timezone.utc).isoformat(),
        }, ConditionExpression="attribute_not_exists(id) OR attribute_not_exists(#entity) OR #entity = :entity",
            ExpressionAttributeNames={"#entity": "entity"},
            ExpressionAttributeValues={":entity": "item"})
        return response(200, "Data stored successfully.")
    except Exception:
        # Do not return SDK error details or credentials to callers.
        return response(500, "Unable to store price.")
