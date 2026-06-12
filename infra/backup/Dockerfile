FROM postgres:16-alpine
RUN apk add --no-cache aws-cli
COPY infra/backup/backup.sh /backup.sh
RUN chmod +x /backup.sh
ENTRYPOINT ["/backup.sh"]
