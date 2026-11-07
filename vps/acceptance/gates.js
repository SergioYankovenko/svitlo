// Evidence evaluator: simulations, unit tests and an engine-only benchmark
// never silently stand in for installed clients, API SLO or external recovery.
export function acceptance(e){
 const gates={
  privateRelease:e.release?.status==='pass'&&e.release?.schemaHashesMatch===true&&e.release?.ownerIsolation===true,
  independentAlerts:e.monitor?.independentHost===true&&e.monitor?.failureDelivered===true&&e.monitor?.recoveryDelivered===true,
  mixedSlo:e.load?.requestedSeconds>=3600&&e.load?.seconds>=3599&&e.load?.offeredAverageRequestsPerSecond===20&&e.load?.readP95ms<=500&&e.load?.ackLoss===0&&e.load?.unexpected5xx===0&&e.load?.full90DayFleetVolumeSeeded===true,
  searchSlo:e.search?.measurement==='full-http-api'&&e.search?.requestsPerSecond>=20&&e.search?.p95ms<=200&&e.search?.exactCorrect===e.search?.exactCases&&e.search?.exactCases>=200&&Number.isFinite(e.search?.indexBytes)&&Number.isFinite(e.search?.peakMemoryBytes),
  projectionLag:e.projection?.p95CommitToApplySeconds<=60&&e.projection?.dependencyOutageAndCatchupTested===true,
  offsitePitr:e.recovery?.restoredFromActualPrivateBaseline===true&&e.recovery?.independentHost===true&&e.recovery?.externalRepository===true&&e.recovery?.ownerAclEpochsPreserved===true&&e.recovery?.afterTargetAbsent===true,
  independentSecretRecovery:e.escrow?.encryptedKeysReadbackVerified===true&&e.escrow?.portableKeyVerified===true&&e.escrow?.offlinePasswordCustodyConfirmed===true,
  androidReader:e.android?.physicalDevice===true&&e.android?.touchAndWidgetMatrix===true,
  androidSensor:e.sensor?.producerVersion===3&&e.sensor?.samsung===true&&e.sensor?.xiaomi===true&&e.sensor?.immutableReplayAndRevocation===true,
  installedPwa:e.pwa?.installed===true&&e.pwa?.permissionOfflineUpdateMatrix===true,
  storeLifecycle:e.billing?.licenseTester===true&&e.billing?.stateMatrix===true&&e.billing?.oldCallbackCannotOverride===true&&e.billing?.crossAccountPurchaseRejected===true,
  soak24h:e.soak?.observedSeconds>=86400&&e.soak?.unexpectedErrors===0,
  noOpenCriticalDefects:e.review?.openP0===0&&e.review?.openP1===0
 };
 return {schemaVersion:1,readyForPaidLaunch:Object.values(gates).every(Boolean),gates,pending:Object.keys(gates).filter(k=>!gates[k]),publicRolloutAuthorized:false};
}
