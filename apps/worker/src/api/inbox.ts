import type { AuthUser } from "../auth";
import type { Env } from "../env";
import { httpError } from "../http";
import {
  getOutbound,
  getOutboundEvents,
  listEvents,
  listInbound,
  listOutbound,
  outboundStats,
  outboundTimeseries,
} from "./inbox_activity";
import {
  deleteAlias,
  listInboxAliases,
  listInboxDomains,
  patchAlias,
} from "./inbox_aliases";
import { composeEmail, fromSuggestions, openInboxStream } from "./inbox_compose";
import { getAttachment, getMessageBody, markRead } from "./inbox_messages";
import { batchFlags, getThreadMessages, listThreads, threadFlags } from "./inbox_threads";

export async function handleInbox(
  url: URL,
  req: Request,
  env: Env,
  user: AuthUser,
  ctx?: ExecutionContext,
): Promise<Response> {
  const path = url.pathname.replace(/^\/api\/inbox/, "");

  if (path === "/stream" && req.method === "GET") return openInboxStream(env, user);
  if (path === "/compose" && req.method === "POST") return composeEmail(req, env, user, ctx);
  if (path === "/from-suggestions" && req.method === "GET") return fromSuggestions(env, user);

  if (path === "/threads" && req.method === "GET") return listThreads(url, env, user);
  if (path === "/threads/batch/flags" && req.method === "POST") return batchFlags(req, env, user);

  const tm = path.match(/^\/threads\/([^/]+)\/messages$/);
  if (tm && req.method === "GET") return getThreadMessages(env, user, tm[1]!);

  const tf = path.match(/^\/threads\/([^/]+)\/flags$/);
  if (tf && req.method === "POST") return threadFlags(req, env, user, tf[1]!);

  const mb = path.match(/^\/messages\/([^/]+)\/body$/);
  if (mb && req.method === "GET") return getMessageBody(env, user, mb[1]!);

  const mr = path.match(/^\/messages\/([^/]+)\/read$/);
  if (mr && req.method === "POST") return markRead(env, user, mr[1]!);

  const att = path.match(/^\/attachments\/([^/]+)$/);
  if (att && req.method === "GET") return getAttachment(env, user, att[1]!);

  if (path === "/domains" && req.method === "GET") return listInboxDomains(env, user);
  if (path === "/aliases" && req.method === "GET") return listInboxAliases(url, env, user);

  const ae = path.match(/^\/aliases\/([^/]+)$/);
  if (ae && req.method === "PATCH") return patchAlias(req, env, user, ae[1]!);
  if (ae && req.method === "DELETE") return deleteAlias(env, user, ae[1]!);

  if (path === "/outbound" && req.method === "GET") return listOutbound(url, env, user);
  if (path === "/outbound/stats" && req.method === "GET") return outboundStats(url, env, user);
  if (path === "/outbound/timeseries" && req.method === "GET") return outboundTimeseries(url, env, user);
  const od = path.match(/^\/outbound\/([^/]+)$/);
  if (od && req.method === "GET") return getOutbound(env, user, od[1]!);
  const oe = path.match(/^\/outbound\/([^/]+)\/events$/);
  if (oe && req.method === "GET") return getOutboundEvents(env, user, oe[1]!);

  if (path === "/inbound" && req.method === "GET") return listInbound(url, env, user);
  if (path === "/events" && req.method === "GET") return listEvents(url, env, user);

  return httpError.notFound(`inbox route ${path} not found`);
}
