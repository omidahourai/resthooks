import React, { Suspense } from 'react'
import styled from 'styled-components'
import { ChargeDisplay } from 'containers'

const Wrapper = styled.div``

export default () => (
  <Wrapper>
    <Suspense fallback={() => <div>`Loading`</div>}>
      aa
      <ChargeDisplay />
    </Suspense>
  </Wrapper>
)
