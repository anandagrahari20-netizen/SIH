# AI backend container — used for Cloud Run (image deploy), Fly.io, or any
# container host. For `gcloud run deploy --source .` this Dockerfile is picked
# up automatically; without it, Cloud Buildpacks + the Procfile are used.

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Cloud Run / Fly inject $PORT; default 8080 for local `docker run`.
ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
