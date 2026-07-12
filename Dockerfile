FROM apify/actor-node:22

COPY --chown=myuser:myuser package*.json ./

# IMPORTANT: Do NOT use --omit=optional here.
# impit's Rust native binary ships via napi-rs optionalDependencies.
# --omit=optional silently skips the binary, causing runtime crashes.
RUN npm --quiet set progress=false \
    && npm install --omit=dev \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

COPY --chown=myuser:myuser . ./

CMD npm start --silent
