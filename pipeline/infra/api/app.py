"""Internet Coaches Dashboard API.

Every route runs behind the Cognito JWT authorizer, so by the time code runs the
caller is a signed-in user. Admins (Cognito group "admin") see every store and
manage users; everyone else gets the stores listed in their custom:stores
attribute (store ids and/or group ids, comma-separated).

The data itself is never proxied through here: /data answers with short-lived
S3 links to exactly the files the caller may read, and the browser fetches
those directly.
"""
import gzip
import json
import os
import re
import urllib.parse

import boto3
from botocore.exceptions import ClientError

BUCKET = os.environ["BUCKET"]
POOL_ID = os.environ["POOL_ID"]
LINK_TTL = int(os.environ.get("LINK_TTL", "900"))

s3 = boto3.client("s3")
idp = boto3.client("cognito-idp")

SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,80}$")


# ----------------------------------------------------------------- helpers

def reply(status, body):
    return {"statusCode": status, "headers": {"Content-Type": "application/json"},
            "body": json.dumps(body, default=str)}


def claims_of(event):
    return (event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})) or {}


def is_admin(claims):
    groups = claims.get("cognito:groups") or ""
    if isinstance(groups, list):
        return "admin" in groups
    return "admin" in [g.strip() for g in str(groups).strip("[]").split(",")]


def load_meta():
    obj = s3.get_object(Bucket=BUCKET, Key="data/meta.json")
    raw = obj["Body"].read()
    if raw[:2] == b"\x1f\x8b":            # stored gzipped (Content-Encoding: gzip)
        raw = gzip.decompress(raw)
    return json.loads(raw)


def allowed_store_ids(claims, meta):
    """Expand the user's custom:stores (store ids and group ids) to store ids."""
    all_ids = [s["id"] for s in meta.get("stores", [])]
    if is_admin(claims):
        return all_ids, True
    wanted = [w.strip() for w in str(claims.get("custom:stores") or "").split(",") if w.strip()]
    groups = {g["id"]: g.get("storeIds", []) for g in meta.get("groups", [])}
    out = []
    for w in wanted:
        if w in groups:
            out.extend(groups[w])
        elif w in all_ids:
            out.append(w)
    seen, uniq = set(), []
    for sid in out:
        if sid not in seen:
            seen.add(sid)
            uniq.append(sid)
    return uniq, False


def presign(key):
    return s3.generate_presigned_url("get_object", Params={"Bucket": BUCKET, "Key": key}, ExpiresIn=LINK_TTL)


# ------------------------------------------------------------------ routes

def get_data(claims):
    meta = load_meta()
    ids, admin = allowed_store_ids(claims, meta)
    files = []
    for sid in ids:
        if SLUG.match(sid):
            files.append({"storeId": sid, "url": presign("data/store/%s.json" % sid)})
    return reply(200, {
        "admin": admin,
        "email": claims.get("email"),
        "name": claims.get("name"),
        "storeIds": ids,
        "meta": presign("data/meta.json"),
        "files": files,
        "generatedAt": meta.get("generatedAt"),
    })


def get_me(claims):
    meta = load_meta()
    ids, admin = allowed_store_ids(claims, meta)
    return reply(200, {"email": claims.get("email"), "name": claims.get("name"), "admin": admin, "storeIds": ids})


def user_view(u, groups=None):
    attrs = {a["Name"]: a["Value"] for a in u.get("Attributes", u.get("UserAttributes", []))}
    return {
        "username": u["Username"],
        "email": attrs.get("email"),
        "name": attrs.get("name"),
        "stores": [x for x in (attrs.get("custom:stores") or "").split(",") if x],
        "status": u.get("UserStatus"),
        "enabled": u.get("Enabled", True),
        "admin": "admin" in (groups or []),
        "created": u.get("UserCreateDate"),
        "lastModified": u.get("UserLastModifiedDate"),
    }


def groups_for(username):
    try:
        res = idp.admin_list_groups_for_user(UserPoolId=POOL_ID, Username=username)
        return [g["GroupName"] for g in res.get("Groups", [])]
    except ClientError:
        return []


def list_users():
    users, token = [], None
    while True:
        kw = {"UserPoolId": POOL_ID, "Limit": 60}
        if token:
            kw["PaginationToken"] = token
        res = idp.list_users(**kw)
        users.extend(res.get("Users", []))
        token = res.get("PaginationToken")
        if not token:
            break
    out = [user_view(u, groups_for(u["Username"])) for u in users]
    out.sort(key=lambda x: (not x["admin"], (x["email"] or "").lower()))
    return reply(200, {"users": out})


def validate_stores(stores, meta):
    ok = {s["id"] for s in meta.get("stores", [])} | {g["id"] for g in meta.get("groups", [])}
    bad = [s for s in stores if s not in ok]
    if bad:
        raise ValueError("unknown store or group id: %s" % ", ".join(bad))


def create_user(body):
    email = (body.get("email") or "").strip().lower()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        return reply(400, {"error": "a valid email is required"})
    stores = [s.strip() for s in body.get("stores", []) if s and s.strip()]
    admin = bool(body.get("admin"))
    meta = load_meta()
    try:
        validate_stores(stores, meta)
    except ValueError as exc:
        return reply(400, {"error": str(exc)})
    if not admin and not stores:
        return reply(400, {"error": "a customer needs at least one store or group"})
    attrs = [{"Name": "email", "Value": email}, {"Name": "email_verified", "Value": "true"},
             {"Name": "custom:stores", "Value": ",".join(stores)}]
    if body.get("name"):
        attrs.append({"Name": "name", "Value": str(body["name"]).strip()[:120]})
    try:
        res = idp.admin_create_user(UserPoolId=POOL_ID, Username=email, UserAttributes=attrs,
                                    DesiredDeliveryMediums=["EMAIL"])
    except ClientError as exc:
        code = exc.response["Error"]["Code"]
        if code == "UsernameExistsException":
            return reply(409, {"error": "that email already has a login"})
        return reply(400, {"error": exc.response["Error"].get("Message", code)})
    username = res["User"]["Username"]
    if admin:
        idp.admin_add_user_to_group(UserPoolId=POOL_ID, Username=username, GroupName="admin")
    return reply(201, {"user": user_view(res["User"], ["admin"] if admin else [])})


def update_user(username, body, caller):
    meta = load_meta()
    if "stores" in body:
        stores = [s.strip() for s in body.get("stores", []) if s and s.strip()]
        try:
            validate_stores(stores, meta)
        except ValueError as exc:
            return reply(400, {"error": str(exc)})
        idp.admin_update_user_attributes(UserPoolId=POOL_ID, Username=username,
                                         UserAttributes=[{"Name": "custom:stores", "Value": ",".join(stores)}])
    if "name" in body:
        idp.admin_update_user_attributes(UserPoolId=POOL_ID, Username=username,
                                         UserAttributes=[{"Name": "name", "Value": str(body["name"] or "").strip()[:120]}])
    if "admin" in body:
        if not body["admin"] and username == caller:
            return reply(400, {"error": "you cannot remove your own admin access"})
        if body["admin"]:
            idp.admin_add_user_to_group(UserPoolId=POOL_ID, Username=username, GroupName="admin")
        else:
            try:
                idp.admin_remove_user_from_group(UserPoolId=POOL_ID, Username=username, GroupName="admin")
            except ClientError:
                pass
    if "enabled" in body:
        if not body["enabled"] and username == caller:
            return reply(400, {"error": "you cannot disable yourself"})
        if body["enabled"]:
            idp.admin_enable_user(UserPoolId=POOL_ID, Username=username)
        else:
            idp.admin_disable_user(UserPoolId=POOL_ID, Username=username)
    u = idp.admin_get_user(UserPoolId=POOL_ID, Username=username)
    return reply(200, {"user": user_view(u, groups_for(username))})


def delete_user(username, caller):
    if username == caller:
        return reply(400, {"error": "you cannot delete yourself"})
    idp.admin_delete_user(UserPoolId=POOL_ID, Username=username)
    return reply(200, {"deleted": username})


def resend_invite(username):
    """A fresh temporary password by email (the invite expires after 14 days)."""
    u = idp.admin_get_user(UserPoolId=POOL_ID, Username=username)
    if u.get("UserStatus") == "FORCE_CHANGE_PASSWORD":
        idp.admin_create_user(UserPoolId=POOL_ID, Username=username, MessageAction="RESEND",
                              DesiredDeliveryMediums=["EMAIL"])
    else:
        idp.admin_reset_user_password(UserPoolId=POOL_ID, Username=username)
    return reply(200, {"sent": username})


def handler(event, context):
    claims = claims_of(event)
    if not claims:
        return reply(401, {"error": "not signed in"})
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path = event.get("rawPath", "")
    params = event.get("pathParameters") or {}
    caller = claims.get("cognito:username") or claims.get("username") or claims.get("sub")

    if path == "/data" and method == "GET":
        return get_data(claims)
    if path == "/me" and method == "GET":
        return get_me(claims)

    # everything below is user management: admins only
    if not is_admin(claims):
        return reply(403, {"error": "admins only"})
    body = {}
    if event.get("body"):
        try:
            body = json.loads(event["body"])
        except ValueError:
            return reply(400, {"error": "body must be JSON"})
    username = urllib.parse.unquote(params.get("username", "")) if params else ""
    try:
        if path == "/users" and method == "GET":
            return list_users()
        if path == "/users" and method == "POST":
            return create_user(body)
        if username and method == "PATCH":
            return update_user(username, body, caller)
        if username and method == "DELETE":
            return delete_user(username, caller)
        if username and path.endswith("/resend") and method == "POST":
            return resend_invite(username)
    except ClientError as exc:
        return reply(400, {"error": exc.response["Error"].get("Message", exc.response["Error"]["Code"])})
    return reply(404, {"error": "no such route"})
