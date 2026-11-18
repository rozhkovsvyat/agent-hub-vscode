import { useAppDispatch, useAppSelector } from "../redux/hooks";
import { deleteCompaction } from "../redux/slices/sessionSlice";
import { compactConversationThunk } from "../redux/thunks/compactConversation";
import { saveCurrentSession } from "../redux/thunks/session";

export const useCompactConversation = () => {
  const dispatch = useAppDispatch();
  const currentSessionId = useAppSelector((state) => state.session.id);

  return async (index: number) => {
    if (!currentSessionId) {
      return;
    }

    await dispatch(compactConversationThunk({ index }));
  };
};

export const useDeleteCompaction = () => {
  const dispatch = useAppDispatch();

  return (index: number) => {
    dispatch(deleteCompaction(index));
    dispatch(
      saveCurrentSession({
        openNewSession: false,
        generateTitle: false,
      }),
    );
  };
};
