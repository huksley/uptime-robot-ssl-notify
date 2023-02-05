const https = require("https");
const http = require("http");
const tls = require("tls");

/* eslint-disable @typescript-eslint/no-empty-function */
const logger = console;
logger.verbose = process.env.LOG_VERBOSE === "1" ? logger.info : () => {};

/** All monitors from uptime robot https://uptimerobot.com/api/ */
const getAllMonitors = async (apiKey) => {
  const res = await request("https://api.uptimerobot.com/v2/getMonitors", {
    method: "POST",
    body: new URLSearchParams({ api_key: apiKey }).toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
  });

  if (res.statusCode > 399) {
    throw new Error(res.statusCode + " " + res.statusMessage);
  }
  if (res.body?.stat !== "ok") {
    throw new Error(res.body?.error?.message);
  }
  return res.body.monitors;
};

/** Return Slack webhook url if defined as contact in Uptime robot https://uptimerobot.com/api/ */
const getSlackWebhook = async (apiKey) => {
  const res = await request("https://api.uptimerobot.com/v2/getAlertContacts", {
    method: "POST",
    body: new URLSearchParams({ api_key: apiKey }).toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
  });
  if (res.statusCode > 399) {
    throw new Error(res.statusCode + " " + res.statusMessage);
  }
  if (res.body?.stat !== "ok") {
    throw new Error(res.body?.error?.message);
  }
  return res.body.alert_contacts.find((c) => c.value.indexOf("hooks.slack.com") >= 0)?.value;
};

const formatSlackBlocks = ({ title, host, port, err, monitorUrl }, blocks) => {
  return [
    ...(blocks.length > 0
      ? [
          {
            type: "divider",
          },
        ]
      : []),
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Failed to check HTTPS for ${title}*

Checked ${host} port ${port} of ${monitorUrl} and got error`,
      },
    },
    {
      type: "section",
      text: {
        type: "plain_text",
        text: `${String(err)}`,
      },
    },
  ];
};

const request = async (url, { method, body, headers }) => {
  const payload = body ? (typeof body == "object" ? JSON.stringify(body) : body) : undefined;
  const u = new URL(url);
  logger.info("HTTP", method || "GET", url, payload ? "payload " + payload.length + " bytes" : "");

  return new Promise((resolve, reject) => {
    const req = (u.protocol === "http:" ? http : https).request(
      url,
      {
        timeout: 10000,
        servername: u.host,
        method: method || "GET",
        headers: {
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": payload.length,
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        logger.verbose("Got response", res.statusCode, res.statusMessage);

        // Collect body
        let data = "";
        res.on("data", function (chunk) {
          data += chunk;
        });

        res.on("end", function () {
          if (
            res.headers["content-type"] === "application/json" ||
            res.headers["content-type"].startsWith("application/json;")
          ) {
            data = JSON.parse(data);
          }
          res.body = data;
          if (res.statusCode && res.statusCode >= 200 && res.statusCode <= 399) {
            resolve(res);
          } else {
            reject(res);
          }
        });
      }
    );
    req.on("error", reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
};

/**
 * Sends notification to Slack
 */
const handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  logger.info("Got event", JSON.stringify(event, null, 2));

  const blocks = [];
  const text = [];
  const logLink = context.logGroupName
    ? `https://${process.env.AWS_REGION || "eu-west-1"}.console.aws.amazon.com/cloudwatch/home?region=${
        process.env.AWS_REGION || "eu-west-1"
      }#logsV2:log-groups/log-group/${encodeURIComponent(context.logGroupName)}/log-events/${encodeURIComponent(
        context.logStreamName
      )}`
    : undefined;

  const apiKey = event?.queryStringParameters?.apiKey;
  if (!apiKey) {
    logger.warn("No uptime robot API key");
    return new Error("No uptime robot API key");
  }

  const monitors = await getAllMonitors(apiKey);
  await Promise.all(
    monitors
      // Only HTTPS
      .filter((monitor) => monitor.url.startsWith("https://"))
      // Only UP and not paused, etc
      .filter((monitor) => monitor.status === 2)
      .map(
        ({ friendly_name: title, url: monitorUrl }) =>
          new Promise((resolve) => {
            logger.info("Checking", title, monitorUrl);
            const url = new URL(monitorUrl);
            const host = url.hostname;
            const port = url.port ? parseInt(url.port, 10) : 443;

            try {
              const sock = tls.connect({ host, port, servername: host }, (info) => {
                logger.info("Connected to", host, port, info, sock.getPeerCertificate()?.valid_to);
                resolve();
              });

              sock.on("error", (err) => {
                logger.warn("Failed", host, port, process.env.LOG_VERBOSE === "1" ? err : String(err));
                text.push("Failed " + host + ":" + port);
                blocks.push(
                  ...formatSlackBlocks(
                    {
                      host,
                      port,
                      monitorUrl,
                      title,
                      err,
                      logLink,
                    },
                    blocks
                  )
                );
                resolve();
              });
            } catch (err) {
              logger.warn("Failed", host, port, process.env.LOG_VERBOSE === "1" ? err : String(err));
              text.push("Failed " + host + ":" + port);
              blocks.push(
                ...formatSlackBlocks(
                  {
                    host,
                    port,
                    monitorUrl,
                    title,
                    err,
                    logLink,
                  },
                  blocks
                )
              );
              resolve();
            }
          })
      )
  );

  const message =
    blocks?.length > 0
      ? {
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: "*UptimeRobot SSL check* " + new Date().toISOString() } },
            ...blocks,
            ...(logLink
              ? [
                  {
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: `<${logLink}|Open log for details>`,
                    },
                  },
                ]
              : []),
          ],
          text: "UptimeRobot SSL check: " + text.join("\n"),
        }
      : undefined;

  const url = await getSlackWebhook(apiKey);
  if (!url) {
    logger.warn("No Slack webhook contact in uptime robot, payload", JSON.stringify(message, null, 2));
    return new Error("No Slack webhook contact");
  }

  try {
    if (message) {
      logger.info("Sending to", url, message);
      const res = await request(url, {
        method: "POST",
        body: message,
      });

      logger.info("Got response", res.statusCode, "body", res.headers["content-type"], res.body);
    }
    
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "OK" }),
    };
  } catch (e) {
    logger.warn("Request failed", url, e.statusCode, e.statusMessage);
    return new Error("Slack send failed!");
  }
};

if (require.main === module) {
  process.env.AWS_REGION = "eu-west-1";
  handler(
    {
      queryStringParameters: {
        apiKey: process.env.UPTIME_ROBOT_API_KEY,
      },
    },
    {}
  );
}

exports.handler = handler;
