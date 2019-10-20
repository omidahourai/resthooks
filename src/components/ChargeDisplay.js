import React from 'react'
import styled from 'styled-components'

const Label = styled.p``
const Value = styled.p``
const Field = styled.div``
const Content = styled.div``
const Header = styled.div``
const Wrapper = styled.div``

export default (props) => (
    <Wrapper>
        <Header>
            <Field>
                <Label>{'id'}</Label>
                <Value>{props.id}</Value>
            </Field>
        </Header>
        <Content>
            <Field>
            </Field>
        </Content>
    </Wrapper>
)
