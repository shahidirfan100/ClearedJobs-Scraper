# Use official Apify SDK base image for JavaScript actors
FROM apify/actor-node:22

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm || true

# Copy source code
COPY . ./

# Run the actor
CMD npm start --silent
