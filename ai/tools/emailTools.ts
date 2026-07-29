import { clampInteger } from "../../core/clampedInteger";
import { compactWhitespace } from "../../core/compactWhitespace";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";
import { asTrimmedNonEmptyStringArray } from "../../core/stringArray";

import { callToolApi } from "./toolApiClient";

type EmailSearchArgs = {
  ownerId?: string;
  mailbox?: string;
  status?: string;
  tag?: string;
  limit?: number;
};

type EmailKeyArgs = {
  dbKey: string;
};

type EmailUpdateTagsArgs = EmailKeyArgs & {
  tags: string[];
};

type EmailProvisionIdentityArgs = {
  agentId: string;
  purpose?: string;
  localPart?: string;
  domain?: string;
  makePrimary?: boolean;
};

type EmailSendArgs = {
  agentId: string;
  fromEmail: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
  text?: string;
  html?: string;
};

type EmailWaitForArgs = EmailSearchArgs & {
  subjectContains?: string;
  fromContains?: string;
  toContains?: string;
  bodyContains?: string;
  timeoutSeconds?: number;
  pollIntervalMs?: number;
};

type EmailExtractVerificationArgs = Partial<EmailKeyArgs> & {
  text?: string;
  html?: string;
};

const emailPreview = (email: any): string => {
  const subject = asOptionalTrimmedString(email?.subject) ?? "(无主题)";
  const from = email?.from?.email || email?.from?.name || "unknown";
  const tags = Array.isArray(email?.tags) && email.tags.length > 0
    ? ` #${email.tags.join(" #")}`
    : "";
  return `- ${subject} | from: ${from} | ${email?.mailbox ?? "mailbox?"}${tags} | ${email?.dbKey ?? ""}`;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeContains = (value?: unknown): string =>
  asTrimmedLowercaseString(value);

const participantList = (emails?: string[]) =>
  Array.isArray(emails)
    ? asTrimmedNonEmptyStringArray(emails).map((email) => ({ email }))
    : [];

const emailText = (email: any): string =>
  [email?.subject, email?.from?.email, email?.from?.name, email?.text, email?.html]
    .filter((value) => typeof value === "string")
    .join("\n");

const matchesWaitFilters = (email: any, args: EmailWaitForArgs): boolean => {
  const subjectContains = normalizeContains(args.subjectContains);
  const fromContains = normalizeContains(args.fromContains);
  const toContains = normalizeContains(args.toContains);
  const bodyContains = normalizeContains(args.bodyContains);

  if (
    subjectContains &&
    !String(email?.subject || "").toLowerCase().includes(subjectContains)
  ) {
    return false;
  }
  if (
    fromContains &&
    !`${email?.from?.email || ""} ${email?.from?.name || ""}`
      .toLowerCase()
      .includes(fromContains)
  ) {
    return false;
  }
  if (toContains) {
    const recipients = Array.isArray(email?.to)
      ? email.to.map((item: any) => item?.email || item?.name || "").join(" ")
      : "";
    if (!recipients.toLowerCase().includes(toContains)) return false;
  }
  if (
    bodyContains &&
    !`${email?.text || ""}\n${email?.html || ""}`.toLowerCase().includes(bodyContains)
  ) {
    return false;
  }
  return true;
};

const stripHtml = (html?: string): string =>
  typeof html === "string"
    ? compactWhitespace(
        html
          .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi, " $1 ")
          .replace(/<[^>]+>/g, " "),
      )
    : "";

const cleanUrl = (url: string): string =>
  url.replace(/[),.;\]}>]+$/g, "");

export const extractEmailVerificationArtifacts = ({
  text,
  html,
}: {
  text?: string;
  html?: string;
}) => {
  const content = `${text || ""}\n${stripHtml(html)}\n${html || ""}`;
  const urlMatches = content.match(/https?:\/\/[^\s<>"']+/g) || [];
  const allLinks = Array.from(new Set(urlMatches.map(cleanUrl)));
  const verificationLinks = allLinks.filter((url) =>
    /(verify|verification|confirm|confirmation|activate|auth|magic|signin|sign-in|login|reset|token|code)/i.test(
      url
    )
  );

  const labeledCodes = Array.from(
    content.matchAll(
      /(?:code|verification|verify|confirm|otp|pin|验证码|校验码|确认码)[^\p{L}\p{N}]{0,24}([A-Z0-9]{4,10})/giu
    )
  ).map((match) => match[1]);
  const numericCodes = content.match(/\b\d{4,8}\b/g) || [];
  const codes = Array.from(new Set([...labeledCodes, ...numericCodes]));

  return {
    codes,
    primaryCode: codes[0] || null,
    verificationLinks,
    primaryLink: verificationLinks[0] || allLinks[0] || null,
    allLinks,
  };
};

export const emailSearchFunctionSchema = {
  name: "email_search",
  description: [
    "查询当前主体可访问的邮件列表。",
    "只返回当前 owner 范围内且通过 delegation/权限检查的邮件。",
    "可按 mailbox、status、tag 和 limit 过滤。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      ownerId: {
        type: "string",
        description: "可选 ownerId。默认使用当前用户 owner；传入其他 owner 会被权限层拒绝。",
      },
      mailbox: {
        type: "string",
        enum: ["inbox", "sent", "archive", "trash", "drafts"],
        description: "邮箱文件夹过滤。",
      },
      status: {
        type: "string",
        enum: ["received", "draft", "queued", "sent", "failed"],
        description: "邮件状态过滤。",
      },
      tag: {
        type: "string",
        description: "按 tag 过滤。",
      },
      limit: {
        type: "number",
        description: "最多返回多少封，默认 50，最大 200。",
      },
    },
    required: [],
  },
};

export const emailReadFunctionSchema = {
  name: "email_read",
  description: "读取一封邮件的完整内容。需要 email:read 权限。",
  parameters: {
    type: "object",
    properties: {
      dbKey: {
        type: "string",
        description: "邮件记录的 dbKey，例如 email-userId-emailId。",
      },
    },
    required: ["dbKey"],
  },
};

export const emailUpdateTagsFunctionSchema = {
  name: "email_update_tags",
  description: "替换一封邮件的 tags。需要 email:manage 权限，不要求 email:read。",
  parameters: {
    type: "object",
    properties: {
      dbKey: {
        type: "string",
        description: "邮件记录的 dbKey。",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "新的 tag 列表，会做去重和空值清理。",
      },
    },
    required: ["dbKey", "tags"],
  },
};

export const emailArchiveFunctionSchema = {
  name: "email_archive",
  description: "把一封邮件移动到 archive mailbox。需要 email:manage 权限。",
  parameters: {
    type: "object",
    properties: {
      dbKey: {
        type: "string",
        description: "邮件记录的 dbKey。",
      },
    },
    required: ["dbKey"],
  },
};

export const emailProvisionIdentityFunctionSchema = {
  name: "email_provision_identity",
  description: [
    "为指定 agent 生成并绑定一个受控域名邮箱身份。",
    "邮箱域名必须由服务端 AGENT_EMAIL_DOMAIN(S) 等配置允许。",
    "该调用会确保 Cloudflare route 已创建，并返回当前 readiness 状态。",
    "当 readinessStatus 不是 ready 时，调用方必须先完成 inbox warmup，直到 alias ingress-ready，再开始真实站点注册。",
    "适合注册网站前为 agent 准备收验证码/验证链接的邮箱。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      agentId: {
        type: "string",
        description: "Agent 的 dbKey，例如 agent-userId-agentId。",
      },
      purpose: {
        type: "string",
        description: "邮箱用途，例如 github-signup；同一 agent+purpose 会生成稳定地址。",
      },
      localPart: {
        type: "string",
        description: "可选邮箱 local part；不传则由服务端按 agentId+purpose 生成。",
      },
      domain: {
        type: "string",
        description: "可选域名；必须在服务端允许的 agent 邮箱域名内。",
      },
      makePrimary: {
        type: "boolean",
        description: "是否设为 agent 主邮箱。默认仅在 agent 没有主邮箱时设为主邮箱。",
      },
    },
    required: ["agentId"],
  },
};

export const emailSendFunctionSchema = {
  name: "email_send",
  description: "以 agent 已绑定邮箱身份发送邮件。需要 email:send 权限。",
  parameters: {
    type: "object",
    properties: {
      agentId: {
        type: "string",
        description: "Agent 的 dbKey。",
      },
      fromEmail: {
        type: "string",
        description: "发件邮箱，必须是该 agent 已绑定的邮箱身份。",
      },
      to: {
        type: "array",
        items: { type: "string" },
        description: "收件邮箱列表。",
      },
      cc: {
        type: "array",
        items: { type: "string" },
      },
      bcc: {
        type: "array",
        items: { type: "string" },
      },
      replyTo: {
        type: "array",
        items: { type: "string" },
      },
      subject: { type: "string" },
      text: { type: "string" },
      html: { type: "string" },
    },
    required: ["agentId", "fromEmail", "to", "subject"],
  },
};

export const emailWaitForFunctionSchema = {
  name: "email_wait_for",
  description: [
    "轮询等待一封符合条件的邮件，适合网站注册后的验证码/验证链接等待。",
    "可按 ownerId、mailbox、subject/from/to/body 关键词过滤。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      ownerId: {
        type: "string",
        description: "邮箱 owner，通常是 agent dbKey。",
      },
      mailbox: {
        type: "string",
        enum: ["inbox", "sent", "archive", "trash", "drafts"],
        default: "inbox",
      },
      subjectContains: { type: "string" },
      fromContains: { type: "string" },
      toContains: { type: "string" },
      bodyContains: { type: "string" },
      tag: { type: "string" },
      timeoutSeconds: {
        type: "number",
        description: "最长等待秒数，默认 60，最大 180。",
      },
      pollIntervalMs: {
        type: "number",
        description: "轮询间隔毫秒，默认 3000，范围 500-10000。",
      },
      limit: {
        type: "number",
        description: "每次查询最多取多少封，默认 20。",
      },
    },
    required: ["ownerId"],
  },
};

export const emailExtractVerificationFunctionSchema = {
  name: "email_extract_verification",
  description: "从指定邮件或文本中提取验证码、验证链接、magic link 或登录链接。",
  parameters: {
    type: "object",
    properties: {
      dbKey: {
        type: "string",
        description: "可选邮件 dbKey；提供后会先读取邮件正文。",
      },
      text: {
        type: "string",
        description: "可选纯文本正文。",
      },
      html: {
        type: "string",
        description: "可选 HTML 正文。",
      },
    },
    required: [],
  },
};

export async function emailSearchFunc(args: EmailSearchArgs, thunkApi: any) {
  const emails = await callToolApi<any[]>(thunkApi, "/rpc/listEmails", args || {}, {
    withAuth: true,
  });
  const items = Array.isArray(emails) ? emails : [];
  return {
    rawData: { count: items.length, items },
    displayData:
      items.length === 0
        ? "没有找到符合条件的邮件。"
        : `找到 ${items.length} 封邮件：\n${items.map(emailPreview).join("\n")}`,
  };
}

export async function emailProvisionIdentityFunc(
  args: EmailProvisionIdentityArgs,
  thunkApi: any
) {
  const result = await callToolApi<any>(
    thunkApi,
    "/rpc/provisionAgentEmailIdentity",
    args,
    { withAuth: true }
  );
  return {
    rawData: result,
    displayData: `已为 agent 生成邮箱身份：${result.emailAddress}`,
  };
}

export async function emailSendFunc(args: EmailSendArgs, thunkApi: any) {
  const email = await callToolApi<any>(
    thunkApi,
    "/rpc/sendEmail",
    {
      agentId: args.agentId,
      from: { email: args.fromEmail },
      to: participantList(args.to),
      cc: participantList(args.cc),
      bcc: participantList(args.bcc),
      replyTo: participantList(args.replyTo),
      subject: args.subject,
      text: args.text,
      html: args.html,
    },
    { withAuth: true }
  );
  return {
    rawData: email,
    displayData: `已发送邮件：${email?.subject || email?.dbKey} | 状态：${email?.status}`,
  };
}

export async function emailWaitForFunc(args: EmailWaitForArgs, thunkApi: any) {
  const timeoutMs = clampInteger(args.timeoutSeconds, 60, 1, 180) * 1000;
  const pollIntervalMs = clampInteger(args.pollIntervalMs, 3000, 500, 10000);
  const startedAt = Date.now();
  let attempts = 0;

  while (Date.now() - startedAt <= timeoutMs) {
    attempts += 1;
    const emails = await callToolApi<any[]>(
      thunkApi,
      "/rpc/listEmails",
      {
        ownerId: args.ownerId,
        mailbox: args.mailbox || "inbox",
        status: args.status,
        tag: args.tag,
        limit: clampInteger(args.limit, 20, 1, 200),
      },
      { withAuth: true }
    );
    const items = Array.isArray(emails) ? emails : [];
    const match = items.find((email) => matchesWaitFilters(email, args));
    if (match) {
      return {
        rawData: { email: match, attempts, waitedMs: Date.now() - startedAt },
        displayData: `收到匹配邮件：\n${emailPreview(match)}\n\n${emailText(match).slice(0, 4000)}`,
      };
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(`等待邮件超时：${Math.ceil(timeoutMs / 1000)} 秒内没有匹配邮件`);
}

export async function emailExtractVerificationFunc(
  args: EmailExtractVerificationArgs,
  thunkApi: any
) {
  let text = args.text;
  let html = args.html;
  let email: any = null;
  if (args.dbKey) {
    email = await callToolApi<any>(thunkApi, "/rpc/getEmail", { dbKey: args.dbKey }, {
      withAuth: true,
    });
    text = typeof email?.text === "string" ? email.text : text;
    html = typeof email?.html === "string" ? email.html : html;
  }
  if (!text && !html) {
    throw new Error("必须提供 dbKey、text 或 html 中至少一个");
  }

  const artifacts = extractEmailVerificationArtifacts({ text, html });
  return {
    rawData: { email, ...artifacts },
    displayData: [
      artifacts.primaryCode ? `验证码：${artifacts.primaryCode}` : "",
      artifacts.primaryLink ? `主要链接：${artifacts.primaryLink}` : "",
      artifacts.verificationLinks.length > 1
        ? `其他验证链接：\n${artifacts.verificationLinks.slice(1).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n") || "没有提取到验证码或链接。",
  };
}

export async function emailReadFunc(args: EmailKeyArgs, thunkApi: any) {
  const email = await callToolApi<any>(thunkApi, "/rpc/getEmail", args, {
    withAuth: true,
  });
  const body =
    asOptionalTrimmedString(email?.text) ??
    asOptionalTrimmedString(email?.html) ??
    "";
  return {
    rawData: email,
    displayData: `${emailPreview(email)}\n\n${body.slice(0, 4000)}`,
  };
}

export async function emailUpdateTagsFunc(
  args: EmailUpdateTagsArgs,
  thunkApi: any
) {
  const email = await callToolApi<any>(thunkApi, "/rpc/updateEmailTags", args, {
    withAuth: true,
  });
  return {
    rawData: email,
    displayData: `已更新邮件 tags：${email?.tags?.join(", ") || "(无)"}`,
  };
}

export async function emailArchiveFunc(args: EmailKeyArgs, thunkApi: any) {
  const email = await callToolApi<any>(thunkApi, "/rpc/archiveEmail", args, {
    withAuth: true,
  });
  return {
    rawData: email,
    displayData: `已归档邮件：${email?.subject || email?.dbKey}`,
  };
}
