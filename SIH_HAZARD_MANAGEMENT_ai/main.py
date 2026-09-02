"""
Firebase Cloud Functions entrypoint for the SIH Citizen Intelligence API.

Deploy (from ../SIH_HAZARD_MANAGEMENT):
    firebase deploy --only functions,hosting,firestore:rules

This packages this directory and deploys the FastAPI app (app/main.py) as a
single 2nd-gen HTTPS function named `api`. Firebase Hosting rewrites  /api/**
to it (see ../SIH_HAZARD_MANAGEMENT/firebase.json), so the browser only ever
calls  https://<project>.web.app/api/...  — same origin, no CORS.

Firebase does NOT strip the /api prefix before invoking the function, and
app/main.py already mounts the real API under /api, so a request for
GET /api/allocate reaches the /allocate route.

Cloud Run / Render still use  `uvicorn app.main:app`  (Procfile / Dockerfile /
render.yaml) unchanged — this file is only for the Firebase Functions path.
Firebase credentials on Functions come from Application Default Credentials
(the runtime service account); no key file is uploaded.

The FastAPI app is ASGI; Firebase's Python functions run a WSGI (gunicorn)
server. `_asgi_to_wsgi` below is a minimal synchronous bridge: it drives the
ASGI coroutine to completion on a throwaway event loop *in the request
thread*. (a2wsgi's threaded-loop bridge deadlocks here — Cloud Run gen2 only
schedules CPU during request handling, so its background loop thread starves.)
"""

import asyncio
from http import HTTPStatus

from firebase_functions import https_fn, options

from app.main import app as _fastapi_app

# The function region MUST match the region in the hosting rewrite
# (../SIH_HAZARD_MANAGEMENT/firebase.json -> hosting.rewrites[].function.region).
options.set_global_options(
    region="asia-south1",
    memory=options.MemoryOption.MB_512,
    timeout_sec=120,
    max_instances=10,
)


def _request_headers(environ):
    headers = []
    for key, value in environ.items():
        if key.startswith("HTTP_"):
            name = key[5:].replace("_", "-").lower()
            headers.append((name.encode("latin-1"), value.encode("latin-1")))
    if environ.get("CONTENT_TYPE"):
        headers.append((b"content-type", environ["CONTENT_TYPE"].encode("latin-1")))
    if environ.get("CONTENT_LENGTH"):
        headers.append((b"content-length", environ["CONTENT_LENGTH"].encode("latin-1")))
    return headers


def _asgi_to_wsgi(asgi_app):
    """Wrap an ASGI 3 application as a synchronous WSGI callable."""

    def wsgi_app(environ, start_response):
        try:
            content_length = int(environ.get("CONTENT_LENGTH") or 0)
        except (TypeError, ValueError):
            content_length = 0
        body = environ["wsgi.input"].read(content_length) if content_length else b""

        path = environ.get("PATH_INFO", "") or "/"
        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": environ.get("SERVER_PROTOCOL", "HTTP/1.1").split("/")[-1],
            "method": environ.get("REQUEST_METHOD", "GET"),
            "scheme": environ.get("wsgi.url_scheme", "https"),
            "path": path,
            "raw_path": path.encode("latin-1"),
            "query_string": environ.get("QUERY_STRING", "").encode("latin-1"),
            "root_path": environ.get("SCRIPT_NAME", ""),
            "headers": _request_headers(environ),
            "server": (
                environ.get("SERVER_NAME"),
                int(environ["SERVER_PORT"]) if environ.get("SERVER_PORT") else None,
            ),
            "client": (environ.get("REMOTE_ADDR"), 0),
            "state": {},
            "extensions": {},
        }

        inbound = [{"type": "http.request", "body": body, "more_body": False}]
        result = {"status": 500, "headers": [], "body": bytearray()}

        async def receive():
            if inbound:
                return inbound.pop(0)
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == "http.response.start":
                result["status"] = message["status"]
                result["headers"] = message.get("headers", []) or []
            elif message["type"] == "http.response.body":
                result["body"].extend(message.get("body", b"") or b"")

        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(asgi_app(scope, receive, send))
        finally:
            asyncio.set_event_loop(None)
            loop.close()

        try:
            phrase = HTTPStatus(result["status"]).phrase
        except ValueError:
            phrase = ""
        start_response(
            f"{result['status']} {phrase}".strip(),
            [(k.decode("latin-1"), v.decode("latin-1")) for k, v in result["headers"]],
        )
        return [bytes(result["body"])]

    return wsgi_app


_wsgi_app = _asgi_to_wsgi(_fastapi_app)


@https_fn.on_request()
def api(req: https_fn.Request) -> https_fn.Response:
    return https_fn.Response.from_app(_wsgi_app, req.environ, buffered=True)
