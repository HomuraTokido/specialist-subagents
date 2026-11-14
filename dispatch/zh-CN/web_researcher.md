# 怎么用 web_researcher（调用方指南）

岗位合同在服务的 `roles/web_researcher.md`，这里只写派活一方怎么用它。通用规矩见组长手册（`dispatch_guide` 不带 `role`）。

## 什么时候派

- 要问的是库外、会变的事实：网页、版本、价格、发布日期、第三方行为。

## brief 必须带齐

- 要回答的那一个问题。
- 判据：查到什么算够。
- 时间或版本的边界。

派之前先 `memory_read {role: "web_researcher"}` 看有没有现成的稳定事实，有就不派。

## 拿到结果之后

- 搜索摘要不是证据：结论要挂在它打开过的原页上，核验看链接本身。
- 稳定事实写回岗位记忆：`memory_write {role: "web_researcher", kind: "fact", body: "结论 + 来源 + 日期"}`。要进 Hwiki 的，派 librarian 写。

## 别做

- 不让它改任何文件。
