# NetMap — image unique servant l'API + l'interface web.
# Compatible Raspberry Pi 5 (arm64) et PC (amd64) : icmplib est en pur Python,
# et les autres dépendances ont des wheels précompilés pour les deux archi.
FROM python:3.12-slim

WORKDIR /app

# Dépendances Python
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Code + interface
COPY backend/app ./app
COPY frontend ./frontend

# La base SQLite vit dans /data (volume Docker → persistante)
ENV NETMAP_DB_PATH=/data/netmap.db \
    NETMAP_PORT=8000
VOLUME ["/data"]

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
