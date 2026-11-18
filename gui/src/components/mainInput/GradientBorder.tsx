import styled from "styled-components";

export const GradientBorder = styled.div<{
  borderRadius?: string;
  borderColor?: string;
  loading: 0 | 1;
}>`
  /* Рамку рисует только InputBoxDiv. Раньше этот слой добавлял вторую
     1px-обводку вокруг неё, поэтому поле выглядело двойным. */
  border-radius: ${(props) => props.borderRadius || "0"};
  padding: 0;
  background: transparent;
  width: 100%;
  display: flex;
  flex-direction: row;
  align-items: center;
  margin-top: ${(props) => (props.loading ? "8px" : "")};
`;
