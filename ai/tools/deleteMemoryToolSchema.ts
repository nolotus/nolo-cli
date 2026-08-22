export const deleteMemoryFunctionSchema = {
  name: "deleteMemory",
  description: [
    "在用户明确/强制要求下，删除用户自身权限范围内的长期记忆。",
    "【两阶段确认与安全防护】物理删除是不可逆操作：",
    "  - 初次调用（未确认，confirmed: false）会进行 Dry-Run 预检并返回匹配到的记忆总数与预览内容；",
    "  - 模型必须向用户汇报预检结果，在用户看到并明确确认后，传入 confirmed: true 才会真正执行物理删除。",
    "【权限边界】严格仅限于当前用户拥有的记忆（ownerType: user, ownerId: 当前用户），严禁越权删除他人或系统数据。",
    "【禁止全量清空】必须提供至少一项过滤条件（ids、contentKeyword、tags 等），禁止无条件全量清空。",
    "支持按 memoryIds (ids)、内容关键词/子串 (contentKeyword)、种类 (kinds) 或标签 (tags) 进行定向删除。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "可选。要精确删除的记忆 ID 列表。",
      },
      contentKeyword: {
        type: "string",
        description: "可选。按内容关键词/子串匹配要删除的记忆内容。",
      },
      kinds: {
        type: "array",
        items: {
          type: "string",
          enum: ["episodic", "semantic", "procedural"],
        },
        description: "可选。过滤要删除的记忆类型。",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "可选。过滤包含指定标签的记忆。",
      },
      confirmed: {
        type: "boolean",
        description:
          "可选。两阶段确认标志。初次调用时为 false（仅获取预览）；只有在用户明确确认执行删除后才传入 true。",
        default: false,
      },
      deletionToken: {
        type: "string",
        description: "可选。预检阶段返回的防篡改 deletionToken，确认阶段可带回以保证操作原子性。",
      },
      reason: {
        type: "string",
        description: "必填。用户明确提出删除的原因或指令描述。",
      },
    },
    required: ["reason"],
  } as const,
};
