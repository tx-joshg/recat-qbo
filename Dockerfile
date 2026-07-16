# Build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY shared ./shared
COPY server ./server
COPY client ./client
RUN npm run build -w server && npm run build -w client

# Runtime stage
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev
COPY prisma ./prisma
RUN npx prisma generate
COPY shared ./shared
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist
EXPOSE 3001
CMD ["sh", "-c", "npx prisma migrate deploy && node server/dist/index.js"]
