#include "paged_attention.hpp"

Plan run_paged_attention(const AttentionArgs& args, const KvCache& kv_cache) {
  auto plan = build_attention_plan(args);
  auto workspace = allocate_workspace(plan.size());
  mirror_to_host(plan, workspace.host_plan());
  launch_paged_kernel(plan.device_view(), kv_cache);
  return plan;
}
