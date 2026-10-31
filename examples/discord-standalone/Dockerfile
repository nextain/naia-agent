FROM node:22-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /workspace/naia-agent
COPY . .
COPY --from=naia-memory package.json /workspace/naia-memory/package.json
COPY --from=naia-memory dist /workspace/naia-memory/dist
COPY --from=naia-kb-compiler package.json /workspace/naia-kb-compiler/package.json
COPY --from=naia-kb-compiler dist /workspace/naia-kb-compiler/dist

RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /opt/naia-agent
RUN mkdir -p /workspace /var/lib/naia-agent \
  && chown node:node /workspace /var/lib/naia-agent
COPY --from=build --chown=node:node /workspace/naia-agent/bin ./bin
COPY --from=build --chown=node:node /workspace/naia-agent/dist ./dist
COPY --from=build --chown=node:node /workspace/naia-agent/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/naia-agent/package.json ./package.json
COPY --from=build --chown=node:node /workspace/naia-agent/scripts/builds ./scripts/builds
VOLUME ["/workspace", "/var/lib/naia-agent"]
# The rootless run example maps the invoking user to this image user (1000:1000).
USER node
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/naia-agent/bin/naia-agent.mjs"]
CMD ["serve"]
