FROM python:3.11-slim-bookworm AS rust-builder

ENV CARGO_HOME=/opt/cargo \
    PATH=/opt/cargo/bin:$PATH \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable

WORKDIR /build
COPY pyproject.toml Cargo.toml Cargo.lock ./
COPY rust ./rust
COPY app ./app
RUN python -m pip install --no-cache-dir 'maturin>=1.8,<2.0' \
    && maturin build --release --locked --interpreter python --out /wheels

FROM python:3.11-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8000 \
    CLOUD_DEPLOYMENT=true \
    LIVE_TRADING_ENABLED=false

WORKDIR /app
COPY requirements.txt .
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY . .
COPY --from=rust-builder /wheels /wheels
RUN python -m pip install --no-cache-dir --no-deps /wheels/*.whl \
    && rm -rf /wheels \
    && groupadd --system --gid 10001 neo \
    && useradd --system --uid 10001 --gid neo --home-dir /app --no-create-home --shell /usr/sbin/nologin neo \
    && mkdir -p data logs \
    && chown -R neo:neo /app/data /app/logs

USER 10001:10001

EXPOSE 8000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips=*"]
