# BizSuite — single-process image (Express API + built SPA), the same
# one-container shape Odoo/ERPNext deploys use. DB is external (Neon/Postgres
# via DATABASE_URL). Runs on Render, Fly, Koyeb, or any VPS unchanged.

# ---- build: full toolchain, compile the SPA -------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY frontend/package.json frontend/
RUN npm ci
COPY packages ./packages
COPY frontend ./frontend
RUN npm run build:web

# ---- runtime: prod deps + server source + built SPA -----------------------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# contracts ships raw TS consumed by the tsx runtime; frontend/package.json
# must exist because the root workspaces field references it.
COPY packages/contracts ./packages/contracts
COPY frontend/package.json frontend/
RUN npm ci --omit=dev
COPY src ./src
COPY --from=build /app/frontend/dist ./frontend/dist
EXPOSE 3000
# node as the direct process (clean SIGTERM on deploys); tsx registered as loader
CMD ["node", "--import", "tsx", "src/server.ts"]
