import type { CityPartner, PartnerPayoutProfile, PartnerWithdrawal } from "../../../types/admin";

interface AdminPartnerFinanceTabProps {
  cityPartners: CityPartner[];
  partnerProfiles: PartnerPayoutProfile[];
  partnerWithdrawals: PartnerWithdrawal[];
  loading: boolean;
  revealedPayouts: Record<string, { accountName?: string; account?: string } | undefined>;
  financeBusyId: string | null;
  showPayoutDetails: (targetId: string, url: string, key: string) => void;
  reviewPayoutProfile: (profile: PartnerPayoutProfile, status: "verified" | "rejected") => void;
  reviewWithdrawal: (withdrawal: PartnerWithdrawal, status: "approved" | "rejected") => void;
  markWithdrawalPaid: (withdrawal: PartnerWithdrawal) => void;
  markWithdrawalFailed: (withdrawal: PartnerWithdrawal) => void;
}

export function AdminPartnerFinanceTab({
  cityPartners,
  partnerProfiles,
  partnerWithdrawals,
  loading,
  revealedPayouts,
  financeBusyId,
  showPayoutDetails,
  reviewPayoutProfile,
  reviewWithdrawal,
  markWithdrawalPaid,
  markWithdrawalFailed,
}: AdminPartnerFinanceTabProps) {
  return (
            <div className="overview-viewport partner-finance-viewport">
              <section className="overview-card">
                <h3>城市合伙人 · {cityPartners.length} 位已开通</h3>
                {loading ? <div className="admin-empty-state">正在加载合伙人名册…</div> : cityPartners.length === 0 ? <div className="admin-empty-state">暂无已开通城市合伙人</div> : cityPartners.map((partner) => (
                  <details className="partner-finance-collapse" key={partner.userId}>
                    <summary><strong>{partner.displayName} · {partner.province ?? ""}{partner.city ?? ""}</strong></summary>
                    <div className="partner-finance-collapse-content">
                      <article className="partner-finance-card">
                        <div className="partner-finance-card-head">
                          <div><strong>{partner.displayName} · {partner.province ?? ""}{partner.city ?? ""}</strong><span>{partner.contact} · 开通于 {new Date(partner.activatedAt).toLocaleDateString("zh-CN")}</span></div>
                          <span className="status-pill completed">城市合伙人</span>
                        </div>
                        <div className="partner-finance-amounts">
                          <span>一级邀请 {partner.directInvites} 人 · 二级邀请 {partner.secondLevelInvites} 人</span>
                          <span>待结算 ¥{partner.pendingCommissionYuan.toFixed(2)}</span>
                          <span>已结算 ¥{partner.settledCommissionYuan.toFixed(2)}</span>
                          <strong>可提现 ¥{partner.withdrawableYuan.toFixed(2)}</strong>
                        </div>
                        <div className="partner-finance-details">
                          收款资料：{partner.payoutVerificationStatus === "verified" ? "已核验" : partner.payoutVerificationStatus === "pending" ? "待审核" : partner.payoutVerificationStatus === "rejected" ? "已驳回" : "未绑定"}
                          {partner.payoutAccountLast4 ? ` · 支付宝尾号 ${partner.payoutAccountLast4}` : ""}
                        </div>
                      </article>
                    </div>
                  </details>
                ))}
              </section>
              <section className="overview-card">
                <h3>收款资料审核 · {partnerProfiles.length} 笔待审核</h3>
                {loading ? <div className="admin-empty-state">正在加载收款资料…</div> : partnerProfiles.length === 0 ? <div className="admin-empty-state">暂无待审核收款资料</div> : partnerProfiles.map((profile) => (
                  <article className="partner-finance-card" key={profile.userId}>
                    <div className="partner-finance-card-head">
                      <div><strong>{profile.displayName}</strong><span>{profile.contact} · {profile.province ?? ""}{profile.city ?? ""}</span></div>
                      <span className="status-pill pending">待审核 · 尾号 {profile.accountLast4}</span>
                    </div>
                    {revealedPayouts[profile.userId] && <div className="partner-finance-details">实名：{revealedPayouts[profile.userId]?.accountName}　账号：{revealedPayouts[profile.userId]?.account}</div>}
                    <div className="partner-finance-actions">
                      <button disabled={financeBusyId === profile.userId} onClick={() => showPayoutDetails(profile.userId, `/api/v1/admin/partner/profiles/${profile.userId}`, profile.userId)}>核验收款资料</button>
                      <button disabled={financeBusyId === profile.userId || !revealedPayouts[profile.userId]} onClick={() => reviewPayoutProfile(profile, "verified")}>审核通过</button>
                      <button disabled={financeBusyId === profile.userId} onClick={() => reviewPayoutProfile(profile, "rejected")}>驳回</button>
                    </div>
                  </article>
                ))}
              </section>
              <section className="overview-card">
                <h3>提现审核与打款 · {partnerWithdrawals.filter((item) => ["pending", "approved"].includes(item.status)).length} 笔待处理</h3>
                {loading ? <div className="admin-empty-state">正在加载提现记录…</div> : partnerWithdrawals.length === 0 ? <div className="admin-empty-state">暂无提现申请</div> : partnerWithdrawals.map((withdrawal) => (
                  <details className="partner-finance-collapse" key={withdrawal.id}>
                    <summary><strong>{withdrawal.displayName} · ¥{withdrawal.amountYuan.toFixed(2)}</strong></summary>
                    <div className="partner-finance-collapse-content">
                      <article className="partner-finance-card">
                        <div className="partner-finance-card-head">
                          <div><strong>{withdrawal.displayName} · ¥{withdrawal.amountYuan.toFixed(2)}</strong><span>{withdrawal.contact} · {withdrawal.createdAt ? new Date(withdrawal.createdAt).toLocaleString("zh-CN") : ""}</span></div>
                          <span className={`status-pill ${withdrawal.status === "paid" ? "completed" : withdrawal.status === "rejected" || withdrawal.status === "failed" ? "failed" : "pending"}`}>{withdrawal.status === "pending" ? "待审核" : withdrawal.status === "approved" ? "待打款" : withdrawal.status === "paid" ? "已打款" : withdrawal.status === "rejected" ? "已驳回" : "打款失败"}</span>
                        </div>
                        <div className="partner-finance-amounts">
                          <span>手续费 ¥{withdrawal.feeYuan.toFixed(2)}</span>
                          <strong>实际到账 ¥{withdrawal.netAmountYuan.toFixed(2)}</strong>
                          <span>支付宝尾号 {withdrawal.accountLast4 ?? "—"}</span>
                        </div>
                        {revealedPayouts[withdrawal.id] && <div className="partner-finance-details">收款人：{revealedPayouts[withdrawal.id]?.accountName}　账号：{revealedPayouts[withdrawal.id]?.account}</div>}
                        {withdrawal.note && <div className="partner-finance-details">处理备注：{withdrawal.note}</div>}
                        {withdrawal.externalReference && <div className="partner-finance-details">转账凭证：{withdrawal.externalReference}</div>}
                        <div className="partner-finance-actions">
                          {["pending", "approved"].includes(withdrawal.status) && <button disabled={financeBusyId === withdrawal.id} onClick={() => showPayoutDetails(withdrawal.userId, `/api/v1/admin/partner/withdrawals/${withdrawal.id}/payout`, withdrawal.id)}>查看收款账户</button>}
                          {withdrawal.status === "pending" && <>
                            <button disabled={financeBusyId === withdrawal.id} onClick={() => reviewWithdrawal(withdrawal, "approved")}>审核通过</button>
                            <button disabled={financeBusyId === withdrawal.id} onClick={() => reviewWithdrawal(withdrawal, "rejected")}>驳回申请</button>
                          </>}
                          {withdrawal.status === "approved" && <>
                            <button disabled={financeBusyId === withdrawal.id} onClick={() => markWithdrawalPaid(withdrawal)}>登记已打款</button>
                            <button disabled={financeBusyId === withdrawal.id} onClick={() => markWithdrawalFailed(withdrawal)}>登记打款失败</button>
                          </>}
                        </div>
                      </article>
                    </div>
                  </details>
                ))}
                <p className="partner-finance-disclaimer">打款由管理员在企业支付宝人工完成。只有核实实际到账后，才可登记“已打款”；本控制台不伪装自动出款。</p>
              </section>
            </div>
  );
}
