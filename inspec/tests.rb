# InSpec tests for checking if container is running properly.
# See: https://www.inspec.io/docs/reference/resources/

describe port(5000) do
  it { should be_listening }
end

describe processes('^node .+ app.js') do
  it { should exist }
  its('entries.length') { should eq 1 }
end

describe http('http://localhost:5000/perfStats_9182738127') do
  its('status') { should eq 200 }
  its('body') { should eq '{}' }
end
