// Keeps peer failures local to the peer card while returning one authenticated contract.
class BackupStatusAggregator {
  constructor(zhiliaohubStatusService, zhitianStatusClient) {
    this.zhiliaohubStatusService = zhiliaohubStatusService;
    this.zhitianStatusClient = zhitianStatusClient;
  }

  async getStatus() {
    const [local, remote] = await Promise.allSettled([
      this.zhiliaohubStatusService.getStatus(),
      this.zhitianStatusClient.getStatus(),
    ]);
    const zhiliaohub = local.status === 'fulfilled'
      ? local.value
      : {
        status: 'unknown',
        reason: 'internal_error',
        label: '未知',
        hint: '计算知了hub备份状态时发生异常。',
      };
    const zhitian = remote.status === 'fulfilled'
      ? remote.value
      : {
        status: 'unreachable',
        reason: 'connection_failed',
        hint: '无法读取知天备份状态，知了hub自身状态不受影响。',
      };
    return { zhiliaohub, zhitian };
  }
}

module.exports = { BackupStatusAggregator };
