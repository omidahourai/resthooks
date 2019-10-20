import React from 'react'
import { useResource } from 'rest-hooks'
import { ChargeResource } from 'resources'
import { ChargeDisplay } from 'components'

export default ({id=1}) => {
    console.log({id})
    const charge = useResource(ChargeResource.detailShape(), {id})
    console.log('got charge',{charge})
    return (
        <ChargeDisplay {...charge} />
    )
}
