curl https://api.example.com/orders \
  -H 'Authorization: Bearer tok-123' \
  -H 'Content-Type: application/json' \
  --data-raw '{
  "note": "it'\''s here",
  "n": 1
}'
