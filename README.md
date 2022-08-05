## Uptime Robot SSL notify

Notifies you over Slack when you have SSL/TLS errors which Uptime Robot does not notify on free plan.

Zero-dependency, simple AWS Lambda to notify you when there is an wrong certificate using monitors configured in [Uptime Robot](https://uptimerobot.com/)

### Usage

- Add to contacts a Slack webhook 
- Create readonly api key
- Deploy with serverless
- Write down endpoint: URL for this function
- Add monitor to uptime robot with `?apiKey=...`
- When there will be SSL/TLS errors it will send you slack message

NOTE: Better set period like 30 mins, because it will send a message on each invocation.

### Deploy

````
> serverless deploy
````
