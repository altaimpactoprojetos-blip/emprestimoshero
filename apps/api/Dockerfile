FROM node:22-alpine
RUN apk add --no-cache postgresql16-client openssl
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace apps/api --include-workspace-root=false || npm ci --workspace apps/api
COPY apps/api apps/api
WORKDIR /app/apps/api
RUN npx prisma generate && npx tsc -p tsconfig.json
EXPOSE 4000
CMD ["node", "dist/src/server.js"]
