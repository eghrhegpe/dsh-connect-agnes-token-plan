> ## Documentation Index
> Fetch the complete documentation index at: https://wiki.agnes-ai.com/llms.txt
> Use this file to discover all available pages before exploring further.

# 常见问题

> 常见问题解答 (FAQ)

## API 接入、定价与订阅

<AccordionGroup>
  <Accordion title="1. 怎么获取 API Key？">
    1. 访问 [Agnes AI 国际站平台](https://platform.agnes-ai.com)并注册或登录账户。
    2. 在开发者控制台进入 **API Key** 管理页面。
    3. 点击创建密钥，并立即复制、妥善保存生成的 Key。完整密钥通常只在创建时展示一次。
    4. 调用 API 时，将 Key 放入请求头：

    ```text theme={null}
    Authorization: Bearer YOUR_API_KEY
    ```

    不要把 API Key 写入前端代码、公开仓库、截图或日志。如果密钥泄露或丢失，请立即删除旧密钥并创建新密钥。
  </Accordion>

  <Accordion title="2. 怎么接入模型？">
    国际站统一使用以下 Base URL：

    ```text theme={null}
    https://apihub.agnes-ai.com/v1
    ```

    接入步骤：

    1. 在对应模型文档中复制准确的模型 ID。
    2. 根据模型类型选择接口：文本模型使用 `/chat/completions`、`/responses` 或 `/messages`，图片模型使用 `/images/generations`，视频模型使用 `/videos`。
    3. 请求头加入 `Authorization: Bearer YOUR_API_KEY` 和 `Content-Type: application/json`。
    4. 按模型文档填写请求参数并发送请求。

    文本模型最小请求示例：

    ```bash theme={null}
    curl https://apihub.agnes-ai.com/v1/chat/completions \
      -H "Authorization: Bearer YOUR_API_KEY" \
      -H "Content-Type: application/json" \
      -d '{
        "model": "agnes-2.5-flash",
        "messages": [{"role": "user", "content": "你好"}]
      }'
    ```

    详细步骤请查看[快速开始](/zh-Hans/docs/quickstart)；需要接入第三方客户端时，请查看顶部的“集成文档”标签页。
  </Accordion>

  <Accordion title="3. 模型如何定价？">
    Agnes AI 按模型和计费项区分价格：

    * 文本模型通常按输入 Token、缓存命中 Token 和输出 Token 计费。
    * 图片模型按输出图片分辨率及超出免费数量的输入参考图片计费。
    * 视频模型按输出分辨率、输出视频时长、输入视频时长及超额参考图片计费。

    刊例价、当前优惠价和具体计费公式请以[国际站模型定价页](/zh-Hans/docs/pricing)为准。Token Plan 是订阅配额方案，与模型按量计费价格是两个不同概念。
  </Accordion>

  <Accordion title="4. Token Plan 是什么？有哪些套餐？">
    Token Plan 是面向高频调用和生产场景的订阅方案。订阅后可使用更高的 RPM，并获得文本请求次数、图片生成张数和视频生成秒数配额。RPM 与订阅配额会同时生效。

    当前提供三档套餐：

    * **Starter（入门版）**：适合个人开发、原型验证和轻量调用。
    * **Plus（专业版）**：适合持续开发、团队测试和中等频率的生产请求。
    * **Pro（高级版）**：适合高频生产调用、智能体工作流和多用户应用。

    各套餐的准确模型范围、RPM 和周期配额请查看 [Token Plan FAQ](/zh-Hans/docs/tokenplan)。
  </Accordion>

  <Accordion title="5. 怎么订阅 Token Plan？">
    1. 登录 [Agnes AI 国际站平台](https://platform.agnes-ai.com)。
    2. 打开 [Token Plan 订阅页面](https://platform.agnes-ai.com/subscribe/subscription?from=website)。
    3. 根据调用规模选择 Starter、Plus 或 Pro，并按照页面提示完成订阅。
    4. 订阅生效后，按控制台提示创建或选择 Token Plan 类型的 API Key。
    5. 使用该 Token Plan Key 调用 API，并在控制台查看 RPM、剩余配额和使用量。

    免费 Key 与 Token Plan Key 使用不同的限制池。创建多个同类型 Key 不会叠加 RPM 或订阅配额。
  </Accordion>

  <Accordion title="6. API 报错怎么排查？">
    首先保存 HTTP 状态码、完整响应体、请求时间和请求 ID（如有），但不要公开完整 API Key。然后依次检查 Base URL、Endpoint、模型 ID、鉴权请求头、JSON 格式和参数类型。

    | 状态码 | 常见原因 | 建议处理 |
    | - | - | - |
    | `400` | 参数缺失、字段位置或类型错误、模型不支持该参数 | 对照对应模型文档检查必填字段和示例；特别注意视频的 `seconds` 使用字符串形式。 |
    | `401` | API Key 无效、已删除、格式错误或 `Bearer` 后缺少空格 | 重新复制 Key，并检查 `Authorization: Bearer YOUR_API_KEY`。 |
    | `402` | 余额、积分、订阅或调用前校验未通过 | 检查账户余额、Token Plan 状态和当前 Key 类型。 |
    | `404` | Endpoint、模型或任务 ID 不存在 | 检查请求路径、模型 ID，以及视频查询使用的 `video_id`。 |
    | `429` | 超过 RPM 或订阅配额 | 降低并发与请求频率，等待限制窗口恢复，并检查剩余配额。 |
    | `5xx` | 服务繁忙、临时上游异常或网络链路问题 | 使用指数退避重试，例如 `1s → 2s → 4s → 8s`；持续失败时联系支持。 |

    如果文本模型正常但图片或视频失败，请进一步核对对应模型的专用 Endpoint 和参数。视频任务应按模型文档使用 `video_id` 轮询。仍无法解决时，请将脱敏后的请求、响应、时间和请求 ID 发送至 [support@agnes-ai.com](mailto:support@agnes-ai.com)。
  </Accordion>
</AccordionGroup>

## 其他常见问题

<AccordionGroup>
  <Accordion title="1. 这个平台是什么？">
    本平台为开发者提供免费的 AI API 服务，让你可以将文本、图像、视频和多模态 AI 能力集成到你的应用中。
  </Accordion>

  <Accordion title="2. API 可以免费使用吗？">
    是的。我们的核心 AI 模型可以无限期免费使用。你可以无时间限制地继续使用免费模型。
  </Accordion>

  <Accordion title="3. 免费用户有什么限制？">
    免费用户受 RPM（每分钟请求数）限制，即每分钟的请求数量可能会受到限制。如果你达到限制，请稍等片刻后再发起请求。
  </Accordion>

  <Accordion title="4. 多模态模型是免费的吗？">
    是的。完整的多模态模型都是免费的，包括文本、图像、视频和多模态能力。
  </Accordion>

  <Accordion title="5. 如何开始使用？">
    注册后，你可以在仪表板中生成 API 密钥，并使用文档中的示例开始发起请求。
  </Accordion>

  <Accordion title="6. 如何查看我的使用情况？">
    你可以在仪表板的"Usage"或"Billing"中查看你的请求使用情况、限制和相关详情。
  </Accordion>

  <Accordion title="7. 为什么 API 响应很慢？">
    响应缓慢可能是由服务器负载高、提示词过长、网络延迟或 RPM 限制引起的。你可以稍后重试、减小请求大小，或切换到其他可用模型。
  </Accordion>

  <Accordion title="8. API 密钥丢失了怎么办？">
    你可以在仪表板中重新生成新的 API 密钥。出于安全考虑，你应该立即删除旧密钥。
  </Accordion>

  <Accordion title="9. 在哪里可以找到文档？">
    你可以在我们的文档中查看集成指南和 API 示例。文档提供了创建 API 密钥和调用模型的分步说明。
  </Accordion>

  <Accordion title="10. 如何获得支持？">
    对于一般问题、文本咨询或集成支持，请通过电子邮件联系我们或加入我们的社区。

    邮箱：[support@agnes-ai.com](mailto:support@agnes-ai.com)
  </Accordion>

  <Accordion title="11. 中文社区问题飞书文档">
    常见的中文社区问题如：请查看飞书[文档](https://icn1d2hdv39m.feishu.cn/wiki/R7TEwjadJibD62kWeS9cubtpnPi)点击这里
  </Accordion>
</AccordionGroup>
