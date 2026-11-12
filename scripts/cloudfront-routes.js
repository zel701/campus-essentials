// CloudFront selects the origin before this function runs; query strings are retained.
function handler(event) {
  var request = event.request;
  if (request.uri.indexOf('/api/') === 0) {
    request.uri = request.uri.substring(4);
  } else if (request.uri === '/admin' || request.uri.indexOf('/admin/') === 0 || request.uri.indexOf('/courses/') === 0) {
    request.uri = '/index.html';
  }
  return request;
}
