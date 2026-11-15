export {resolveTeamUsageScope} from './scope.js'
// Future policy must intersect both daemon binding and current authorization.
// Historical rows alone never grant visibility. No team HTTP route is registered.
export const teamUsagePolicy={enabled:false,bindingBeforeJoin:'not_enabled',exitVisibility:'not_enabled',viewRoles:'not_enabled'} as const
