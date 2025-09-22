FROM tiangolo/nginx-rtmp

COPY streamer.conf /etc/nginx/nginx.conf
COPY stunnel.conf /etc/stunnel/stunnel.conf

RUN apt-get update && \
    apt-get install -y stunnel4 ca-certificates && \
    mkdir -p /etc/stunnel && \
    chmod 600 /etc/stunnel/stunnel.conf

CMD sh -c "stunnel /etc/stunnel/stunnel.conf && nginx -g 'daemon off;'"
