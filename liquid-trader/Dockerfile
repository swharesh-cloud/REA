# Alternative to deploy.sh: run the engine in Docker on any server.
#   docker compose up -d        (see docker-compose.yml)
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HOME=/data
RUN useradd --system --home-dir /data --shell /usr/sbin/nologin trader \
 && mkdir -p /data && chown trader:trader /data
WORKDIR /app
COPY liquid_trader ./liquid_trader
USER trader
VOLUME ["/data"]
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/', timeout=4)"
# 0.0.0.0 inside the container only; docker-compose publishes it on the host's 127.0.0.1
CMD ["python", "-m", "liquid_trader", "--headless", "--bind", "0.0.0.0", "--port", "8765"]
