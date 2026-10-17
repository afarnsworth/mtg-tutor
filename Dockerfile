# Packages the already-built app (`npm run data && npm run build` → dist/).
FROM nginx:alpine
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY nginx/headers.conf /etc/nginx/snippets/headers.conf
COPY dist/ /usr/share/nginx/html/
HEALTHCHECK --interval=60s --timeout=5s CMD wget -q --spider http://127.0.0.1/version.json || exit 1
