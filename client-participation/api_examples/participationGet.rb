require 'net/http'
require 'uri'
require 'json'

uri = URI('https://preprod.pol.is/api/v3/participation')
params = {
   'conversation_id' => '97zyYJ9PWVJ07lke'
}
uri.query = URI.encode_www_form(params)

http = Net::HTTP.new('preprod.pol.is', 443)
http.use_ssl = true

request = Net::HTTP::Get.new(uri, {
    'Content-Type' =>'application/json'
})
request.basic_auth ENV['POLIS_API_KEY'], ''

response = http.request(request)

puts response.body

