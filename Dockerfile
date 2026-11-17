FROM node:22-alpine
WORKDIR /app
COPY serve.mjs ./
COPY dist ./dist
ENV PORT=8000 HOST=0.0.0.0
EXPOSE 8000
USER node
CMD ["node", "serve.mjs"]
