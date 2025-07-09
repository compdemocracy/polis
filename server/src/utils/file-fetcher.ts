import _ from "underscore";
import { encode } from "html-entities";
import replaceStream from "replacestream";
import request from "request-promise"; // includes Request, but adds promise methods

import { ConversationType } from "../d";
import { failJson } from "./fail";
import Config from "../config";
import logger from "./logger";

function makeFileFetcher(
  hostname?: string,
  port?: string | number,
  path?: string,
  headers?: { "Content-Type": string },
  preloadData?: { conversation?: ConversationType }
) {
  return function (
    req: { headers?: { host: any }; path: any; pipe: (arg0: any) => void },
    res: { set: (arg0: any) => void }
  ) {
    if (!hostname) {
      failJson(res, 500, "polis_err_file_fetcher_serving_to_domain");
      return;
    }
    const url = "http://" + hostname + ":" + port + path;
    logger.info("fetch file from " + url);
    let x = request(url);
    req.pipe(x);
    if (!_.isUndefined(preloadData)) {
      x = x.pipe(
        replaceStream(
          '"REPLACE_THIS_WITH_PRELOAD_DATA"',
          JSON.stringify(preloadData)
        )
      );
    }

    let fbMetaTagsString =
      '<meta property="og:image" content="https://s3.amazonaws.com/pol.is/polis_logo.png" />\n';
    if (preloadData && preloadData.conversation) {
      fbMetaTagsString +=
        '    <meta property="og:title" content="' +
        encode(preloadData.conversation.topic) +
        '" />\n';
      fbMetaTagsString +=
        '    <meta property="og:description" content="' +
        encode(preloadData.conversation.description) +
        '" />\n';
    }
    x = x.pipe(
      replaceStream("<!-- REPLACE_THIS_WITH_FB_META_TAGS -->", fbMetaTagsString)
    );

    res.set(headers);

    // @ts-ignore - Legacy Express v3 response type mismatch
    x.pipe(res);
    x.on("error", function (err: any) {
      failJson(res, 500, "polis_err_finding_file " + path, err);
    });
  };
}

function browserSupportsPushState(req: { headers?: { [x: string]: string } }) {
  return !/MSIE [23456789]/.test(req?.headers?.["user-agent"] || "");
}

function fetchIndex(
  req: {
    path: string;
    headers?: { host: string; "user-agent"?: string; origin?: string };
    pipe: (arg0: any) => void;
  },
  res: {
    writeHead: (arg0: number, arg1: { Location: string }) => void;
    end: () => any;
    set: (arg0: any) => void;
    status?: (code: number) => any;
    header?: (name: string, value: any) => void;
    _headers?: { [key: string]: any };
    redirect?: (url: string) => void;
  },
  preloadData: { conversation?: ConversationType },
  port: string | number | undefined
) {
  const headers = {
    "Content-Type": "text/html",
  };
  if (!Config.isDevMode) {
    Object.assign(headers, {
      "Cache-Control": "no-cache",
    });
  }

  const indexPath = "/index.html";

  function isUnsupportedBrowser(req: { headers?: { [x: string]: string } }) {
    return /MSIE [234567]/.test(req?.headers?.["user-agent"] || "");
  }

  const doFetch = makeFileFetcher(
    Config.staticFilesHost,
    port,
    indexPath,
    headers,
    preloadData
  );
  if (isUnsupportedBrowser(req)) {
    // @ts-ignore - Legacy Express v3 request type mismatch
    const fetchUnsupportedBrowserPage = makeFileFetcher(
      Config.staticFilesHost,
      Config.staticFilesParticipationPort,
      "/unsupportedBrowser.html",
      {
        "Content-Type": "text/html",
      }
    );
    return fetchUnsupportedBrowserPage(req, res);
  } else if (
    !browserSupportsPushState(req) &&
    req.path.length > 1 &&
    !/^\/api/.exec(req.path)
  ) {
    res.writeHead(302, {
      Location: "https://" + req?.headers?.host + "/#" + req.path,
    });

    return res.end();
  } else {
    // @ts-ignore - Legacy Express v3 request type mismatch
    return doFetch(req, res);
  }
}

export { makeFileFetcher, fetchIndex };
