# syntax=docker/dockerfile:1
#
# Pi coding agent sandbox
# Based on: mark/pi-sandbox (git.mrkc.net/mark/pi-sandbox)
# Enhanced with:
#   - PI_UID / PI_GID build args (match external Unraid user)
#   - All models.json fields (except cost) parameterizable via env vars
#
# Build:
#   docker build \
#     --build-arg PI_UID=1000 \
#     --build-arg PI_GID=100 \
#     -t pi-sandbox:latest .
#
# Run (override any field at runtime):
#   docker run --rm -it \
#     -e PI_LLM_BASE_URL="http://vLLM_Qwen3.8_27B_BF16:8000/v1" \
#     -e PI_LLM_MODEL_ID="Qwen/Qwen3.8-27B" \
#     -e PI_LLM_API_KEY="nerdtastic" \
#     -e PI_LLM_REASONING=true \
#     -e PI_LLM_CONTEXT_WINDOW=262144 \
#     -e PI_LLM_MAX_TOKENS=32768 \
#     -v /mnt/user/appdata/pi/workspace:/home/pi/workspace \
#     pi-sandbox:latest \
#     -p "your task"

FROM ubuntu:24.04

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# ---------------------------------------------------------------------------
# Build args
#   PI_UID / PI_GID   -> in-container user must match the external Unraid user
#   PI_USER_NAME      -> username; use a numeric-safe name for useradd
#   NODE_MAJOR_VERSION -> pin the major Node line (bump deliberately)
#   PI_NPM_VERSION    -> npm tag or exact version of @earendil-works/pi-coding-agent
# ---------------------------------------------------------------------------
ARG PI_UID=1000
ARG PI_GID=100
ARG PI_USER_NAME=pi
ARG PI_USER_HOME=/home/${PI_USER_NAME}
ARG PI_LOCAL_BIN=${PI_USER_HOME}/.local/bin
ARG NODE_MAJOR_VERSION=26
ARG NODE_INSTALL_DIR=${PI_USER_HOME}/.local/share/nodejs
ARG PI_NPM_VERSION=latest

# ---------------------------------------------------------------------------
# APT dependencies
# ---------------------------------------------------------------------------
ENV DEBIAN_FRONTEND=noninteractive
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
        ca-certificates \
        curl \
        git \
        libatomic1 \
        man-db \
        ripgrep \
        sudo \
        vim \
        wget \
        xz-utils \
    && apt-get clean all \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Non-root user with matching UID/GID
# ---------------------------------------------------------------------------
RUN if getent group ${PI_GID} >/dev/null; then \
        groupmod -g ${PI_GID} --new-name="${PI_USER_NAME}" ${PI_GID}; \
    else \
        groupadd -g ${PI_GID} "${PI_USER_NAME}"; \
    fi
RUN if getent passwd ${PI_UID} >/dev/null; then \
        usermod -u ${PI_UID} --home "${PI_USER_HOME}" --shell /bin/bash ${PI_UID}; \
        usermod -d "${PI_USER_HOME}" -G sudo -a ${PI_UID}; \
    else \
        useradd -u ${PI_UID} -g ${PI_GID} -G sudo -m -d "${PI_USER_HOME}" \
                -s /bin/bash "${PI_USER_NAME}"; \
    fi
RUN chown -R "${PI_UID}:${PI_GID}" "${PI_USER_HOME}" \
    && usermod -a -G sudo "${PI_USER_NAME}"

WORKDIR "${PI_USER_HOME}"
USER "${PI_USER_NAME}"
RUN mkdir -p "${PI_LOCAL_BIN}"

# ---------------------------------------------------------------------------
# Node.js (installed to $HOME so the non-root user owns it)
# ---------------------------------------------------------------------------
ENV PATH="${PI_LOCAL_BIN}:${NODE_INSTALL_DIR}/bin:${PATH}"
RUN NODE_DIST_FILE="$(curl -s https://nodejs.org/dist/latest-v${NODE_MAJOR_VERSION}.x/SHASUMS256.txt \
        | grep -Eo 'node-.*-linux-x64.tar.xz')" \
    && mkdir -p "${NODE_INSTALL_DIR}" \
    && curl -s -o- "https://nodejs.org/dist/latest-v${NODE_MAJOR_VERSION}.x/${NODE_DIST_FILE}" \
        | tar -xJf - -C "${NODE_INSTALL_DIR}" --strip-components=1 \
    && rm -f "${NODE_DIST_FILE}" \
    && node --version \
    && npm --version

# ---------------------------------------------------------------------------
# Pi coding agent
#   --ignore-scripts: matches upstream supply-chain convention
#   pi update + pi update --extensions: fetch latest model data + extensions
# ---------------------------------------------------------------------------
RUN npm install -g --ignore-scripts \
        @earendil-works/pi-coding-agent@${PI_NPM_VERSION} \
    && pi update \
    && pi update --extensions

# ---------------------------------------------------------------------------
# Runtime environment variables
#   - PI_CODING_AGENT_DIR: where pi stores config, sessions, models.json
#   - WORKSPACE_DIR: default working dir for tasks
#   - PI_LLM_*: all non-cost fields in models.json (override at runtime with -e)
#   - PI_OFFLINE / PI_SKIP_VERSION_CHECK / PI_TELEMETRY: keep pi quiet
#     on a LAN (no outbound calls to pi.dev)
# ---------------------------------------------------------------------------
ENV PI_CODING_AGENT_DIR=${PI_USER_HOME}/.pi/agent \
    WORKSPACE_DIR=${PI_USER_HOME}/workspace

# Provider name (key in models.json "providers" object)
ENV PI_LLM_PROVIDER_NAME=vllm

# Provider config
ENV PI_LLM_BASE_URL=http://vLLM_Qwen3.8_27B_BF16:8000/v1
ENV PI_LLM_API=openai-completions
ENV PI_LLM_API_KEY=nerdtastic

# Model config
ENV PI_LLM_MODEL_ID=Qwen/Qwen3.8-27B
ENV PI_LLM_MODEL_NAME="Qwen/Qwen3.8-27B (vLLM)"
ENV PI_LLM_REASONING=true
ENV PI_LLM_INPUT=text
ENV PI_LLM_CONTEXT_WINDOW=262144
ENV PI_LLM_MAX_TOKENS=32768

# pi runtime behaviour
ENV PI_OFFLINE=1
ENV PI_SKIP_VERSION_CHECK=1
ENV PI_TELEMETRY=0
ENV AI_AGENT=pi
ENV PI_CODING_AGENT=true

# ---------------------------------------------------------------------------
# Entrypoint script — generates models.json then execs pi
# ---------------------------------------------------------------------------
COPY --chown=${PI_UID}:${PI_GID} config/entrypoint.sh /opt/pi/entrypoint.sh
RUN chmod +x /opt/pi/entrypoint.sh

# Ensure dirs exist
RUN mkdir -p "${WORKSPACE_DIR}" "${PI_CODING_AGENT_DIR}"

WORKDIR "${WORKSPACE_DIR}"

ENTRYPOINT ["/opt/pi/entrypoint.sh"]
