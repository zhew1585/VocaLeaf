FROM public.ecr.aws/docker/library/python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.7.13 /uv /bin/uv
# ffmpeg encodes HLS segments (AAC, MPEG-TS).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src src
RUN uv sync --frozen --no-dev
RUN useradd --system worker
USER worker
CMD ["python", "-m", "vocaleaf_worker"]
