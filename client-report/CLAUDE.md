# Polis Client Report Development

## Starting the client-report service

Run the development server with:

```
cd client-report
SERVICE_URL=http://localhost npm start
```

This will start the client-report development server on port 5010:

- Development URL: http://localhost:5010/index_report.html

## Testing Narrative Reports

To test the narrative report functionality, including Delphi topics:

1. Start the client-report dev server as shown above
2. Access the narrative report using the production URL pattern:
   - Production URL: http://localhost/report/r6vbnhffkxbd7ifmfbdrd

The changes to detect and display Delphi topics should be visible in:

- Browser console logs (for debugging)
