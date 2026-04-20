FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# System packages
RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv python3-tk \
    git build-essential \
    curl ca-certificates \
    openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Clone the REAL Archipelago MultiWorld Randomizer from GitHub
# (the 'archipelago' pip package is an unrelated project — do NOT use it)
RUN git clone --depth 1 https://github.com/ArchipelagoMW/Archipelago.git /opt/archipelago

# Patch ModuleUpdate.py: append a no-op update() that overrides the original.
# The original calls input() when package versions mismatch, which crashes
# non-interactively. Appending a second def is valid Python — last definition wins.
RUN printf '\n\ndef update(yes=False): return  # non-interactive Docker override\n' \
    >> /opt/archipelago/ModuleUpdate.py

# Use a virtualenv so Archipelago gets exactly its pinned versions
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install -r /opt/archipelago/requirements.txt

# Put the venv first on PATH so python3 resolves to it everywhere,
# including in Node.js child_process.spawn() calls
ENV PATH="/opt/venv/bin:$PATH"

# Make the Archipelago source importable for the Python helper scripts
ENV PYTHONPATH="/opt/archipelago"

# Wrapper scripts pointing directly to Archipelago's entry points
RUN printf '#!/bin/sh\nexec /opt/venv/bin/python3 /opt/archipelago/Generate.py "$@"\n' \
      > /usr/local/bin/ArchipelagoGenerate && chmod +x /usr/local/bin/ArchipelagoGenerate
RUN printf '#!/bin/sh\nexec /opt/venv/bin/python3 /opt/archipelago/MultiServer.py "$@"\n' \
      > /usr/local/bin/ArchipelagoServer && chmod +x /usr/local/bin/ArchipelagoServer

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /data/apworlds /data/archives /data/temp && \
    chmod +x entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
