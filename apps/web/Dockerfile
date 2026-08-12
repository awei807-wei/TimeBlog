FROM node:22-alpine AS deps
WORKDIR /app
# The build context is the repository root.  Installing from the root lockfile
# keeps workspace resolution deterministic and prevents a second lockfile from
# silently drifting in the web image.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci
FROM deps AS build
COPY apps/web apps/web
RUN npm run build --workspace apps/web
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
EXPOSE 3000
CMD ["node","apps/web/server.js"]
