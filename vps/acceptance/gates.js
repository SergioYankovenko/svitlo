// Evidence evaluator: simulations, unit tests and an engine-only benchmark
// never silently stand in for installed clients, API SLO or external recovery.
export function acceptance(e){
 const sameImage=proof=>/^sha256:[a-f0-9]{64}$/.test(e.release?.image||'')&&proof?.image===e.release.image;
 const within=(value,limit)=>Number.isFinite(value)&&value>=0&&value<=limit;
 const gates={
  privateRelease:e.release?.status==='pass'&&e.release?.schemaHashesMatch===true&&e.release?.ownerIsolation===true,
  independentAlerts:e.monitor?.independentHost===true&&e.monitor?.failureDelivered===true&&e.monitor?.recoveryDelivered===true&&within(e.monitor?.detectionSeconds,300),
  mixedSlo:sameImage(e.load)&&e.load?.requestedSeconds>=3600&&e.load?.seconds>=3599&&e.load?.offeredAverageRequestsPerSecond===20&&within(e.load?.readP95ms,500)&&e.load?.ackLoss===0&&e.load?.unexpected5xx===0&&e.load?.full90DayFleetVolumeSeeded===true,
  burstSlo:sameImage(e.burst)&&e.burst?.offeredRequestsPerSecond>=100&&e.burst?.requestedSeconds>=30&&e.burst?.unexpected5xx===0&&e.burst?.ackLoss===0&&e.burst?.boundedBacklog===true&&e.burst?.recovered===true,
  searchSlo:sameImage(e.search)&&e.search?.measurement==='full-http-api'&&e.search?.requestsPerSecond>=20&&within(e.search?.p95ms,200)&&e.search?.exactCorrect===e.search?.exactCases&&e.search?.exactCases>=200&&e.search?.indexBytes>0&&e.search?.peakMemoryBytes>0,
  projectionLag:sameImage(e.projection)&&within(e.projection?.p95CommitToApplySeconds,60)&&e.projection?.dependencyOutageAndCatchupTested===true,
  continuousDeploy:sameImage(e.deploy)&&e.deploy?.writesDuringSwitch===true&&e.deploy?.ackLoss===0&&e.deploy?.duplicateEffects===0&&e.deploy?.oldAssetsAccessible===true,
  offsitePitr:e.recovery?.restoredFromActualPrivateBaseline===true&&e.recovery?.independentHost===true&&e.recovery?.externalRepository===true&&e.recovery?.ownerAclEpochsPreserved===true&&e.recovery?.afterTargetAbsent===true&&within(e.recovery?.rpoSeconds,900)&&within(e.recovery?.rtoSeconds,7200),
  independentSecretRecovery:e.escrow?.encryptedKeysReadbackVerified===true&&e.escrow?.portableKeyVerified===true&&e.escrow?.offlinePasswordCustodyConfirmed===true,
  androidReader:e.android?.physicalDevice===true&&e.android?.touchAndWidgetMatrix===true,
  androidSensor:e.sensor?.producerVersion===3&&e.sensor?.samsung===true&&e.sensor?.xiaomi===true&&e.sensor?.immutableReplayAndRevocation===true,
  installedPwa:e.pwa?.installed===true&&e.pwa?.permissionOfflineUpdateMatrix===true,
  storeLifecycle:e.billing?.licenseTester===true&&e.billing?.stateMatrix===true&&e.billing?.oldCallbackCannotOverride===true&&e.billing?.crossAccountPurchaseRejected===true,
  soak24h:sameImage(e.soak)&&e.soak?.observedSeconds>=86400&&e.soak?.unexpectedErrors===0,
  noOpenCriticalDefects:e.review?.openP0===0&&e.review?.openP1===0
 };
 return {schemaVersion:1,readyForPaidLaunch:Object.values(gates).every(Boolean),gates,pending:Object.keys(gates).filter(k=>!gates[k]),publicRolloutAuthorized:false};
}
