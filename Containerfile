FROM docker.io/library/node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=9080 SDM_CREDENTIALS_FILE=/run/secrets/sdm-credentials
WORKDIR /app
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
USER node
EXPOSE 9080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "const tls=!!process.env.TLS_CERT_FILE;require(tls?'https':'http').get((tls?'https':'http')+'://127.0.0.1:9080/healthz',tls?{ca:require('fs').readFileSync(process.env.TLS_CERT_FILE)}:{},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server.js"]
