# Experience Repository

## Purpose

经验数据的文件存储 adapter，提供同进程串行事务和原子文件替换；不依赖 state-store 或默认产品配置。

## Responsibilities / Non-Responsibilities

- 负责固定文件定位、规范 store 读取、不可变历史保护、事务串行、临时文件同步与原子 rename。
- 不负责经验业务检索、项目认证、工作流、发布 Gate、跨进程协调、损坏数据迁移或恢复为默认值。

## Public API

`createExperienceRepository({rootDir,filesystem?})` 返回冻结的 `{path,read,transact}`。rootDir 必填绝对路径，不能是磁盘根；path 固定为 `<rootDir>/experiences.json`。不接受用户给定文件名、相对路径或 record ID 路径。

`read()` → Promise<独立 store 副本>。文件不存在时返回 schema 1 空 store，不创建目录。读操作也进入同一队列。

`transact(mutator)` → Promise<result 副本>。mutator 同步接收独立草稿，返回 `{changed:boolean,result}`；异步返回值拒绝。changed=false 必须完全不修改草稿，否则报错；changed=true 只能追加版本，旧 records 前缀逐字不变，adapter 将 repository revision 加 1。只有完成持久化后才返回成功。

## Inputs / Outputs

store 的 schema、字段、上限与版本约束见 [experience-contract.md](experience-contract.md)。可选 filesystem 是 `node:fs/promises` 兼容端口，仅供故障注入；需要 lstat/mkdir/readFile/open/rename/unlink，open 返回 writeFile/sync/close 句柄。不能把不可信实现注入生产路径。

队列以规范绝对文件路径为键，Windows 忽略大小写；模块内所有工厂实例共享队列。事务异常不会阻塞后续事务。不会返回内部 store 引用。

## Invariants

- 所有已存在的目录祖先必须是真实目录；拒绝 symlink/junction、非普通目标文件与目标硬链接。创建目录前后及 rename 前重复检查。
- 写入唯一同目录 `.experiences.<uuid>.tmp`，使用 `wx` 与 0600，writeFile → sync → close → rename。失败不主动覆盖原文件；临时文件尽力清理。
- 损坏 JSON、未知 schema、非法字段、证据或版本历史、超限文件均明确失败。绝不悄悄替换为空 store。
- changed=false 不增加 revision、不写文件。事务不得删除、重排或修改旧历史。

## Dependencies / Side Effects

允许 `node:fs/promises`、`node:path`、`node:crypto` 与公开 experience-contract API。禁止 state-store、HTTP、Provider 或 Mission workflow 依赖。副作用仅根目录内文件操作及进程内队列；UUID 只用于临时文件名，不提供业务时钟；不启动进程、硬件或网络。

## Error Contract

`EXPERIENCE_STORAGE_PATH_INVALID`：根或祖先不安全，修正配置；`EXPERIENCE_STORE_READ_FAILED` / `EXPERIENCE_STORE_WRITE_FAILED`=503：检查 I/O，写失败后可重试；`EXPERIENCE_STORE_CORRUPT`=503：保留现场，交由外部显式修复，不自动重试覆盖。领域 INVALID/CAPACITY 原样传播；`EXPERIENCE_HISTORY_CONFLICT`=409。异步 mutator/错误返回值/no-op 草稿变更为 TypeError。

## Example

```js
const repository = createExperienceRepository({ rootDir: trustedStorageRoot });
const snapshot = await repository.read();
```

写入通过 [应用服务](application/experience-service.md)，避免调用者复制领域规则。

## Verification

`node tests/experience-service-test.mjs`：不同实例并发、同证据幂等、原子 rename 故障、损坏文件字节保留、目录 junction 拒绝、追加历史限制。测试使用隔离临时目录，finally 清理。

## Change Checklist / Known Limitations

变更文件布局、事务返回值或错误码必须更新本契约、服务与测试。仅支持单进程，不能与其他进程共享写入；注入根应由可信宿主拥有。检查不能消除敌对外部进程的 TOCTOU、路径别名或系统崩溃风险；文件 fsync 后 rename，但不保证目录元数据断电持久性。不提供自动压缩/备份/跨文件事务；清理失败可能遗留不参与读取的 tmp 文件。
