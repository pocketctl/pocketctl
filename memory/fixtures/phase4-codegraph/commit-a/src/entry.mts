import { leftPad } from 'left-pad'
import { buildLabel } from './core/service.js'

export const entryLabel = leftPad(buildLabel({ title: 'entry', status: 'new' }), 12, '0')
