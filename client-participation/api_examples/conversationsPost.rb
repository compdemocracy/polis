require 'net/http'
require 'uri'
require 'json'

uri = URI.parse('https://pol.is/api/v3/conversations')

http = Net::HTTP.new(uri.host, uri.port)
http.use_ssl = true

request = Net::HTTP::Post.new(uri.path, {'Content-Type' =>'application/json'})
request.basic_auth ENV['POLIS_API_KEY'], ''

data = {
    'topic' => "Should we raise the minimum wage?",
    'description' => "It's currently under $10/hr, What do you think?",
    'is_public' => false,
    'strict_moderation' => false,
}

request.body = data.to_json
response = http.request(request)

puts response.body
