curl https://example.com/upload \
  -F title=Holiday \
  -F 'meta={"a":1};type=application/json' \
  --form-string 'tricky=@not;a file' \
  -F 'photo=@"/home/jane/My Pictures/beach.jpg";type=image/jpeg' \
  -F doc=@/tmp/a.pdf
