# Optional. The free Whisper + Ollama path is the Mac script, ./start.sh.
# This image only runs the web app. Point it at Ollama on the host, or set
# TRANSCRIBE_PROVIDER=openai and NOTES_PROVIDER=openai with OPENAI_API_KEY.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["npm", "start"]
