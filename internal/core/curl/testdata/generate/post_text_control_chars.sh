curl https://example.com/t \
  -H 'Content-Type: text/plain; charset=utf-8' \
  --data-raw $'tab\there\r\nback\\slash \'q\''
